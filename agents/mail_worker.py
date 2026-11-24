"""Асинхронный почтовый воркер (Mail Worker) AI Dev Orchestrator.

Назначение: читать новые письма из IMAP-ящиков, отсекать дубли и мусор,
экономить токены ИИ и отправлять только полезные события в C++ ядро по HTTP.

Источник ящиков (backend/DB слой):

* ``mail_accounts`` в PostgreSQL - единственный источник истины. Воркер читает
  список активных ящиков через ``asyncpg``; RLS-политика
  ``mail_accounts_worker_select_active`` сама отдаёт только ``is_active = TRUE``
  (например ``oshkines@mail.ru``), поэтому в SQL нет ``WHERE is_active``;
* пароль в таблице не хранится: там лежит имя переменной окружения
  (``env_password_key = 'ENV_MAIL_PRIMARY_PASSWORD'``), а значение читается
  через ``os.environ.get()``;
* ``--no-db`` оставляет legacy-режим: ящики берутся из
  ``workers.mail_worker.providers`` без обращения к PostgreSQL.

Каскадная стратегия (чем дальше шаг - тем дороже, поэтому он выполняется реже):

1. **White List** - отправитель в ``white_list`` / ``white_list_domains``: ИИ не
   вызывается вообще (0 токенов), скачивается полное тело, алерт уходит с
   ``priority=HIGH`` и ``category=WHITELIST``.
2. **Дешёвый ИИ** - ``deepseek-chat``: скачиваются только заголовки и первые
   ``classify_chars`` символов тела. Модель обязана вернуть строгий JSON
   ``{"category": "...", "summary": "...", "spam_tag": null, "spam_url": null}``
   (Pydantic-схема :class:`EmailClassification`). Категории: ``WHITELIST``,
   ``CRITICAL``, ``VACANCY``, ``SPAM_VALUABLE``, ``SPAM``; приоритет выводится
   из категории, ``SPAM`` игнорируется (ядро не зовётся).
3. **Тяжёлый ИИ** - ``deepseek-reasoner`` (DeepSeek-R1): только для ``CRITICAL``.
   Полное тело скачивается асинхронно и уходит в суммаризатор; в ядро едет
   краткая смысловая выжимка для инженера.

Архитектура (Pure Async, без ``Thread`` и ``asyncio.to_thread``):

* каждый ящик из ``mail_accounts`` (в ``--no-db`` - из конфига) живёт в своей
  корутине, ящики запускаются конкурентно через :func:`asyncio.gather`; зависание
  или блокировка одного провайдера не тормозит остальные;
* весь сетевой I/O - корутины: ``aioimaplib`` (IMAP4rev1), ``httpx`` (POST в ядро),
  ``AsyncOpenAI`` (DeepSeek);
* на каждый шаг IMAP стоит жёсткий таймаут ``asyncio.wait_for``; при обрыве связи
  сессия пересоздаётся с экспоненциальным backoff (``reconnect`` в конфиге).

Секреты: значения берутся **только** из ``os.environ`` по именам переменных
(``ENV_*`` в конфиге, ``env_password_key`` в БД). Файл ``.env`` загружается при
старте через ``python-dotenv`` с ``override=False`` (переменные Windows имеют
приоритет); секреты не попадают ни в ``stdout``, ни в ``stderr``, DSN в логах
маскируется (:func:`mask_dsn`).

LLM Structured Output (требование ДЗ): ответ классификатора проверяется
Pydantic-схемой :class:`EmailClassification`
(``category``, ``summary``, ``spam_tag``, ``spam_url``), каждый запрос ограничен
таймаутом 15 с, повторяется до 3 раз с экспоненциальной задержкой и уходит на
резервную модель при сбое основной. Письма ``SPAM_VALUABLE`` сохраняются в
``valuable_spam`` и помечаются ``\\Deleted`` в ящике.

Запуск (Windows 11, PowerShell, из корня проекта):

    # 1. Секреты: либо в .env (подхватывается автоматически), либо в сессии.
    $env:DATABASE_URL = "postgresql://navigator_worker:<pass>@127.0.0.1:5432/ai_dev_orchestrator"
    $env:ENV_DEEPSEEK_API_KEY = "<deepseek-key>"
    $env:ENV_MAIL_PRIMARY_USERNAME = "oshkines@mail.ru"
    $env:ENV_MAIL_PRIMARY_PASSWORD = "<app-password>"

    # 2. Проверка конфигурации без сети (пароли маскируются).
    .\\\\.venv\\\\Scripts\\\\python.exe agents\\\\mail_worker.py --dry-run

    # 3. Один цикл опроса (отладка, запуск по расписанию ядром).
    .\\\\.venv\\\\Scripts\\\\python.exe agents\\\\mail_worker.py --once --provider primary

    # 4. Штатная работа: сервис, ящики опрашиваются параллельно.
    .\\\\.venv\\\\Scripts\\\\python.exe agents\\\\mail_worker.py

    # 5. Синхронизация папок ящика (mail_folders): IMAP LIST + modified UTF-7.
    .\\.venv\\Scripts\\python.exe agents\\mail_worker.py --sync-folders

Коды выхода: 0 - штатная остановка (Ctrl+C), ``--once``, ``--dry-run`` или
             ``--sync-folders``;
             1 - фатальная ошибка рантайма; 2 - ошибка конфигурации.
Диагностика - в ``stderr`` (UTF-8, русский язык), события - JSON-строки в ``stdout``.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import html
import json
import os
import quopri
import re
import sys
from dataclasses import dataclass, field, replace
from datetime import datetime
from email.header import decode_header, make_header
from email.message import Message
from email.parser import BytesHeaderParser, BytesParser
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Literal, Mapping, Protocol, Sequence
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

# Скрипт запускается и как agents\\mail_worker.py, и как модуль agents.mail_worker:
# добавляем свой каталог в sys.path, чтобы импорт общего слоя работал в обоих случаях.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from notification_channels import (  # noqa: E402 - импорт после правки sys.path
    DEFAULT_CONFIG,
    EXIT_CONFIG_ERROR,
    EXIT_OK,
    MSK_FALLBACK,
    PROJECT_ROOT,
    USER_AGENT,
    ConfigError,
    configure_stdio,
    emit,
)

WORKER_ID: str = "agents/mail_worker.py"
EXIT_RUNTIME_ERROR: int = 1

# Категории и приоритеты - фиксированный контракт с моделью-классификатором.
CATEGORY_VACANCY: str = "VACANCY"
CATEGORY_SPAM_VALUABLE: str = "SPAM_VALUABLE"
CATEGORY_CRITICAL: str = "CRITICAL"
CATEGORY_SPAM: str = "SPAM"
CATEGORY_WHITELIST: str = "WHITELIST"
CATEGORIES: frozenset[str] = frozenset(
    {
        CATEGORY_WHITELIST,
        CATEGORY_CRITICAL,
        CATEGORY_VACANCY,
        CATEGORY_SPAM_VALUABLE,
        CATEGORY_SPAM,
    }
)
PRIORITY_HIGH: str = "HIGH"
PRIORITY_LOW: str = "LOW"
PRIORITIES: frozenset[str] = frozenset({PRIORITY_HIGH, PRIORITY_LOW})

# Приоритет выводится из категории детерминированно: модель не решает, звать ли
# инженера. SPAM уходит в ignored_low, остальное - в ядро.
PRIORITY_BY_CATEGORY: Mapping[str, str] = {
    CATEGORY_WHITELIST: PRIORITY_HIGH,
    CATEGORY_CRITICAL: PRIORITY_HIGH,
    CATEGORY_VACANCY: PRIORITY_HIGH,
    CATEGORY_SPAM_VALUABLE: PRIORITY_HIGH,
    CATEGORY_SPAM: PRIORITY_LOW,
}

# Значения по умолчанию для полей, которых может не быть в конфиге.
DEFAULT_CLASSIFY_CHARS: int = 200
DEFAULT_SNIPPET_BYTES: int = 4096
DEFAULT_BODY_CHARS: int = 12000
DEFAULT_SUMMARY_CHARS: int = 700
DEFAULT_MAX_MESSAGES: int = 10
DEFAULT_MAX_DELIVERY_ATTEMPTS: int = 3
DEFAULT_CORE_URL: str = "http://127.0.0.1:8080"
DEFAULT_NOTIFY_PATH: str = "/api/v1/notify"
MAX_REASON_CHARS: int = 200
MAX_HEADER_CHARS: int = 400
MAX_AI_RESPONSE_CHARS: int = 4000

# Контроль стоимости и устойчивости ИИ (требование ДЗ).
DEFAULT_AI_TIMEOUT_SEC: float = 15.0
DEFAULT_AI_RETRY_ATTEMPTS: int = 3
DEFAULT_AI_RETRY_BASE_DELAY_SEC: float = 1.5
MAX_AI_RETRY_DELAY_SEC: float = 8.0
DEFAULT_AI_MAX_TOKENS: int = 400
MAX_AI_TOKENS_CAP: int = 1024
DEFAULT_SUMMARY_MAX_TOKENS: int = 700
DEFAULT_FALLBACK_MODEL: str = "deepseek-reasoner"
MAX_CLASSIFICATION_SUMMARY_CHARS: int = 600
MAX_SPAM_TAG_CHARS: int = 64
MAX_SPAM_URL_CHARS: int = 2048

# PostgreSQL: имена таблиц/политик и параметры пула.
DEFAULT_DATABASE_URL_ENV: str = "DATABASE_URL"
DEFAULT_DB_MIN_POOL: int = 1
DEFAULT_DB_MAX_POOL: int = 5
DEFAULT_DB_COMMAND_TIMEOUT_SEC: float = 15.0
DEFAULT_DB_CONNECT_TIMEOUT_SEC: float = 10.0
DEFAULT_MIGRATION_PATH: str = "db/migrations/001_init_schema.sql"

# SQL-запросы воркера. В выборке ящиков НЕТ WHERE is_active: фильтр выполняет
# RLS-политика mail_accounts_worker_select_active (см. db/migrations/001).
SQL_FETCH_ACCOUNTS: str = """
SELECT id, label, email, imap_host, imap_port, use_ssl, mailbox,
       env_password_key, username_env_key, poll_interval_sec,
       max_messages_per_poll, is_active
FROM mail_accounts
ORDER BY id
"""

SQL_FETCH_AI_INSTRUCTIONS: str = """
SELECT scope, scope_key, model, fallback_model, max_tokens, temperature, priority
FROM ai_instructions
ORDER BY priority, id
"""

SQL_UPSERT_FOLDER: str = """
INSERT INTO mail_folders (account_id, name, raw_name, delimiter, flags,
                          special_use, is_selectable, last_synced_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, now())
ON CONFLICT (account_id, name) DO UPDATE
SET raw_name       = EXCLUDED.raw_name,
    delimiter      = EXCLUDED.delimiter,
    flags          = EXCLUDED.flags,
    special_use    = EXCLUDED.special_use,
    is_selectable  = EXCLUDED.is_selectable,
    last_synced_at = now()
RETURNING id
"""

SQL_UPSERT_EMAIL: str = """
INSERT INTO emails (account_id, external_id, message_id, sender, sender_name,
                    subject, received_at, category, priority, summary, spam_tag,
                    spam_url, status, is_deleted, ai_model, processed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
ON CONFLICT (account_id, external_id) DO UPDATE
SET message_id   = COALESCE(EXCLUDED.message_id, emails.message_id),
    sender       = EXCLUDED.sender,
    sender_name  = EXCLUDED.sender_name,
    subject      = EXCLUDED.subject,
    received_at  = EXCLUDED.received_at,
    category     = COALESCE(EXCLUDED.category, emails.category),
    priority     = COALESCE(EXCLUDED.priority, emails.priority),
    summary      = COALESCE(EXCLUDED.summary, emails.summary),
    spam_tag     = COALESCE(EXCLUDED.spam_tag, emails.spam_tag),
    spam_url     = COALESCE(EXCLUDED.spam_url, emails.spam_url),
    status       = EXCLUDED.status,
    is_deleted   = emails.is_deleted OR EXCLUDED.is_deleted,
    ai_model     = COALESCE(EXCLUDED.ai_model, emails.ai_model),
    processed_at = now(),
    updated_at   = now()
RETURNING id
"""

SQL_INSERT_VALUABLE_SPAM: str = """
INSERT INTO valuable_spam (email_id, account_id, spam_tag, spam_url, summary,
                           sender, subject, received_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (email_id) DO UPDATE
SET spam_tag = COALESCE(EXCLUDED.spam_tag, valuable_spam.spam_tag),
    spam_url = COALESCE(EXCLUDED.spam_url, valuable_spam.spam_url),
    summary  = EXCLUDED.summary
RETURNING id
"""

SQL_MARK_EMAIL_DELETED: str = """
UPDATE emails
SET is_deleted = TRUE, status = 'deleted', updated_at = now()
WHERE id = $1
"""

SQL_TOUCH_ACCOUNT: str = """
UPDATE mail_accounts
SET last_sync_at = now(), last_error = $2
WHERE id = $1
"""


# Регулярные выражения разбора ответов IMAP и ответов модели.
FETCH_META_RE = re.compile(rb"^\d+\s+FETCH\s*\(")
JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")
HTML_SCRIPT_RE = re.compile(r"<(script|style)\b.*?</\1>", re.DOTALL | re.IGNORECASE)
INLINE_SPACES_RE = re.compile(r"[ \t\u00a0]+")
MANY_NEWLINES_RE = re.compile(r"\n{3,}")
ENV_NAME_RE = re.compile(r"^ENV_[A-Z0-9_]+$")
# Ответ модели иногда приходит в markdown-обёртке: ```json ... ```.
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
# Строка ответа IMAP LIST: (\HasNoChildren) "/" "INBOX"
LIST_LINE_RE = re.compile(
    r'^\((?P<flags>[^)]*)\)\s+(?P<delimiter>NIL|"[^"]*")\s+(?P<name>.+)$',
    re.IGNORECASE,
)
LIST_PREFIX_RE = re.compile(r"^\*?\s*(?:LIST|LSUB)\s+", re.IGNORECASE)
ENV_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


_STDIO_READY: bool = False


def ensure_utf8_stdio() -> None:
    """Один раз переводит ``stdout``/``stderr`` в UTF-8.

    ``main()`` делает это при старте CLI, но воркер может использоваться и как
    библиотека: тогда кодировку фиксирует первый же лог, иначе PowerShell с cp866
    покажет кириллицу как мусор.
    """
    global _STDIO_READY
    if _STDIO_READY:
        return
    configure_stdio()
    _STDIO_READY = True


def log(message: str) -> None:
    """Пишет диагностику в ``stderr``: UTF-8, время МСК, русский язык.

    ``stdout`` зарезервирован под JSON-события для ядра, поэтому все подробности
    (включая ошибки сети и переподключения) уходят в ``stderr``.
    """
    ensure_utf8_stdio()
    stamp = datetime.now(tz=MSK_FALLBACK).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {message}", file=sys.stderr, flush=True)


def emit_event(provider_id: str, action: str, **fields: Any) -> None:
    """Пишет в ``stdout`` одну JSON-строку события (контракт «ядро ↔ воркер»)."""
    ensure_utf8_stdio()
    emit(
        {
            "worker": "mail_worker",
            "worker_id": WORKER_ID,
            "provider": provider_id,
            "action": action,
            **fields,
        }
    )


class MailWorkerError(RuntimeError):
    """Базовая ошибка воркера: сеть, IMAP-сессия, ИИ-анализ, доставка."""


class ImapSessionError(MailWorkerError):
    """Сбой IMAP-сессии (обрыв, отказ авторизации, ошибка команды) - нужен reconnect."""


class ImapCommandTimeout(ImapSessionError):
    """Команда IMAP не уложилась в жёсткий таймаут ``asyncio.wait_for``."""


class AiAnalysisError(MailWorkerError):
    """Модель вернула невалидный ответ (не JSON, чужая категория или приоритет)."""

@dataclass(frozen=True, slots=True)
class AISettings:
    """Параметры каскада DeepSeek (ключ - только из окружения).

    ``fallback_model`` включается после исчерпания повторов основной модели;
    ``retry_attempts``/``retry_base_delay_sec`` задают экспоненциальный backoff,
    ``max_tokens`` ограничивает стоимость ответа (может переопределяться
    строкой ``ai_instructions`` из PostgreSQL).
    """

    base_url: str = "https://api.deepseek.com"
    api_key: str = field(default="", repr=False)
    classifier_model: str = "deepseek-chat"
    summarizer_model: str = "deepseek-reasoner"
    fallback_model: str = DEFAULT_FALLBACK_MODEL
    classify_chars: int = DEFAULT_CLASSIFY_CHARS
    json_mode: bool = True
    timeout_sec: float = DEFAULT_AI_TIMEOUT_SEC
    retry_attempts: int = DEFAULT_AI_RETRY_ATTEMPTS
    retry_base_delay_sec: float = DEFAULT_AI_RETRY_BASE_DELAY_SEC
    max_tokens: int = DEFAULT_AI_MAX_TOKENS
    summary_max_tokens: int = DEFAULT_SUMMARY_MAX_TOKENS
    instruction_source: str = "config"

    @property
    def ready(self) -> bool:
        """``True``, если API-ключ найден в окружении."""
        return bool(self.api_key)


@dataclass(frozen=True, slots=True)
class DatabaseSettings:
    """Параметры PostgreSQL: DSN из окружения, пул и путь миграции.

    Сама строка подключения не печатается: для логов есть :attr:`masked_dsn`.
    """

    dsn: str = field(default="", repr=False)
    dsn_env: str = DEFAULT_DATABASE_URL_ENV
    min_size: int = DEFAULT_DB_MIN_POOL
    max_size: int = DEFAULT_DB_MAX_POOL
    command_timeout_sec: float = DEFAULT_DB_COMMAND_TIMEOUT_SEC
    connect_timeout_sec: float = DEFAULT_DB_CONNECT_TIMEOUT_SEC
    migrations_path: str = DEFAULT_MIGRATION_PATH

    @property
    def ready(self) -> bool:
        """``True``, если ``DATABASE_URL`` задан - можно подключаться."""
        return bool(self.dsn)

    @property
    def masked_dsn(self) -> str:
        """DSN без пароля (безопасен для ``stdout`` и ``stderr``)."""
        return mask_dsn(self.dsn)


@dataclass(frozen=True, slots=True)
class CoreSettings:
    """Адрес C++ ядра и политика повторов HTTP POST."""

    http_url: str = DEFAULT_CORE_URL
    notify_path: str = DEFAULT_NOTIFY_PATH
    timeout_sec: float = 10.0
    retries: int = 2

    @property
    def endpoint(self) -> str:
        """Полный URL эндпоинта уведомлений."""
        return f"{self.http_url.rstrip('/')}/{self.notify_path.lstrip('/')}"

    @property
    def masked_endpoint(self) -> str:
        """URL без query-параметров - безопасен для логов."""
        return self.endpoint.split("?", 1)[0]


@dataclass(frozen=True, slots=True)
class Limits:
    """Ограничения объёма: они напрямую влияют на расход токенов."""

    max_messages_per_poll: int = DEFAULT_MAX_MESSAGES
    snippet_bytes: int = DEFAULT_SNIPPET_BYTES
    body_chars: int = DEFAULT_BODY_CHARS
    summary_chars: int = DEFAULT_SUMMARY_CHARS
    max_delivery_attempts: int = DEFAULT_MAX_DELIVERY_ATTEMPTS


@dataclass(frozen=True, slots=True)
class ReconnectSettings:
    """Политика переподключения: экспоненциальный backoff с потолком."""

    initial_delay_sec: float = 5.0
    max_delay_sec: float = 300.0
    backoff_factor: float = 1.7

    def next_delay(self, current: float) -> float:
        """Возвращает следующую задержку: рост в ``backoff_factor`` раз до потолка."""
        grown = max(current, self.initial_delay_sec) * max(self.backoff_factor, 1.0)
        return min(grown, max(self.max_delay_sec, self.initial_delay_sec))


@dataclass(frozen=True, slots=True)
class ProviderSettings:
    """Один почтовый ящик: IMAP-сервер, таймауты, белый список, интервал опроса."""

    id: str
    host: str
    port: int = 993
    use_ssl: bool = True
    username: str = ""
    password: str = field(default="", repr=False)
    mailbox: str = "INBOX"
    search: tuple[str, ...] = ("UNSEEN",)
    poll_interval_sec: float = 300.0
    connect_timeout_sec: float = 15.0
    command_timeout_sec: float = 30.0
    max_messages: int = DEFAULT_MAX_MESSAGES
    white_list: frozenset[str] = frozenset()
    white_list_domains: frozenset[str] = frozenset()
    enabled: bool = True
    account_id: int | None = None
    label: str = ""

    @property
    def has_credentials(self) -> bool:
        """``True``, если в окружении нашлись и логин, и пароль."""
        return bool(self.username) and bool(self.password)

    @property
    def masked_account(self) -> str:
        """Логин для логов: домен полезен, локальная часть скрыта."""
        name, _, domain = self.username.partition("@")
        if not name or not domain:
            return "***"
        return f"{name[0]}***@{domain}"

    def is_whitelisted(self, address: str) -> bool:
        """Проверяет адрес по белому списку адресов и доменов (регистр не важен)."""
        return is_whitelisted(address, self.white_list, self.white_list_domains)


@dataclass(frozen=True, slots=True)
class Settings:
    """Разобранный блок ``workers.mail_worker`` + параметры PostgreSQL."""

    config_path: Path
    enabled: bool
    ai: AISettings
    core: CoreSettings
    limits: Limits
    reconnect: ReconnectSettings
    providers: tuple[ProviderSettings, ...]
    database: DatabaseSettings = field(default_factory=DatabaseSettings)


class EmailClassification(BaseModel):
    """Строгая схема ответа классификатора (LLM Structured Output).

    Ровно четыре поля: лишние ключи отбрасываются (``extra="ignore"``),
    категория вне контракта и невалидный URL приводят к ошибке валидации.
    Приоритет и «звать ли инженера» модель не решает - это делает воркер.
    """

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    category: Literal["WHITELIST", "CRITICAL", "VACANCY", "SPAM_VALUABLE", "SPAM"]
    summary: str = Field(default="", description="1-2 предложения по-русски")
    spam_tag: str | None = Field(default=None, description="promo, sale, coupon")
    spam_url: str | None = Field(default=None, description="http(s)-ссылка из письма")

    @field_validator("category", mode="before")
    @classmethod
    def _normalize_category(cls, value: Any) -> Any:
        """Приводит ``spam-valuable``/``spam valuable`` к каноническому виду."""
        if isinstance(value, str):
            return value.strip().upper().replace("-", "_").replace(" ", "_")
        return value

    @field_validator("summary", mode="before")
    @classmethod
    def _clamp_summary(cls, value: Any) -> str:
        """Нормализует пробелы и обрезает выжимку до безопасной длины (``null`` -> ``""``)."""
        return normalize_whitespace("" if value is None else str(value))[
            :MAX_CLASSIFICATION_SUMMARY_CHARS
        ]

    @field_validator("spam_tag")
    @classmethod
    def _clamp_tag(cls, value: str | None) -> str | None:
        """Оставляет короткий тег или ``None``."""
        text = normalize_whitespace(value or "")[:MAX_SPAM_TAG_CHARS]
        return text or None

    @field_validator("spam_url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Пропускает только абсолютные http(s)-ссылки (никаких ``javascript:``)."""
        text = (value or "").strip()
        if not text:
            return None
        parsed = urlsplit(text)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            return None
        return text[:MAX_SPAM_URL_CHARS]


@dataclass(frozen=True, slots=True)
class Classification:
    """Вердикт воркера: категория, производный приоритет и полезная нагрузка."""

    category: str
    priority: str
    reason: str = ""
    summary: str = ""
    spam_tag: str | None = None
    spam_url: str | None = None

    @property
    def is_critical(self) -> bool:
        return self.category == CATEGORY_CRITICAL

    @property
    def is_low(self) -> bool:
        return self.priority == PRIORITY_LOW

    @property
    def is_valuable_spam(self) -> bool:
        return self.category == CATEGORY_SPAM_VALUABLE

    @property
    def is_whitelist(self) -> bool:
        return self.category == CATEGORY_WHITELIST



@dataclass(frozen=True, slots=True)
class EmailEnvelope:
    """Заголовки письма + фрагмент тела, достаточные для классификации."""

    seq: str
    sender_name: str
    address: str
    subject: str
    message_id: str
    received_at: str
    content_type: str = "text/plain"
    charset: str = "utf-8"
    transfer_encoding: str = ""

    @property
    def external_id(self) -> str:
        """Стабильный идентификатор письма для дедупликации в ядре."""
        return self.message_id or f"{self.address}:{self.subject}:{self.received_at}:{self.seq}"


@dataclass(frozen=True, slots=True)
class MailAccount:
    """Активный ящик из ``mail_accounts`` (пароль в БД не хранится)."""

    id: int
    email: str
    imap_host: str
    imap_port: int = 993
    use_ssl: bool = True
    mailbox: str = "INBOX"
    env_password_key: str = ""
    username_env_key: str = ""
    poll_interval_sec: float = 120.0
    max_messages_per_poll: int = DEFAULT_MAX_MESSAGES
    label: str = ""
    is_active: bool = True

    @property
    def username(self) -> str:
        """Логин: значение ENV-переменной, иначе сам адрес ящика."""
        if self.username_env_key:
            value = os.environ.get(self.username_env_key, "").strip()
            if value:
                return value
        return self.email

    @property
    def password(self) -> str:
        """Пароль читается **только** из окружения по имени переменной."""
        if not self.env_password_key:
            return ""
        return os.environ.get(self.env_password_key, "").strip()

    @property
    def has_credentials(self) -> bool:
        """``True``, если логин и пароль нашлись в окружении."""
        return bool(self.username) and bool(self.password)

    @property
    def masked_account(self) -> str:
        """Адрес для логов: домен полезен, локальная часть скрыта."""
        name, _, domain = self.email.partition("@")
        if not name or not domain:
            return "***"
        return f"{name[0]}***@{domain}"

    def to_provider(self, *, fallback: ProviderSettings | None = None) -> ProviderSettings:
        """Превращает строку БД в :class:`ProviderSettings` для IMAP-сессии.

        Белый список и поисковый критерий берутся из одноимённого провайдера
        конфига (если он есть): БД хранит только транспортные параметры.
        """
        return ProviderSettings(
            id=self.email,
            host=self.imap_host,
            port=self.imap_port,
            use_ssl=self.use_ssl,
            username=self.username,
            password=self.password,
            mailbox=self.mailbox or "INBOX",
            search=fallback.search if fallback else ("UNSEEN",),
            poll_interval_sec=self.poll_interval_sec,
            max_messages=self.max_messages_per_poll,
            white_list=fallback.white_list if fallback else frozenset(),
            white_list_domains=fallback.white_list_domains if fallback else frozenset(),
            enabled=True,
            account_id=self.id,
            label=self.label or self.email,
        )


@dataclass(frozen=True, slots=True)
class FolderInfo:
    """Папка из ответа IMAP ``LIST`` (имя уже декодировано из modified UTF-7)."""

    name: str
    raw_name: str = ""
    delimiter: str = ""
    flags: tuple[str, ...] = ()
    special_use: str | None = None
    is_selectable: bool = True


@dataclass(frozen=True, slots=True)
class EmailRecord:
    """Строка журнала ``emails``, готовая к UPSERT через asyncpg."""

    account_id: int
    external_id: str
    sender: str
    sender_name: str
    subject: str
    received_at: datetime
    message_id: str | None = None
    category: str | None = None
    priority: str | None = None
    summary: str | None = None
    spam_tag: str | None = None
    spam_url: str | None = None
    status: str = "classified"
    is_deleted: bool = False
    ai_model: str | None = None


def parse_received_at(value: str) -> datetime:
    """Разбирает ISO-момент письма; при сбое - текущее время МСК."""
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        moment = datetime.now(tz=MSK_FALLBACK)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=MSK_FALLBACK)
    return moment


def classification_from_model(
    payload: EmailClassification,
    *,
    reason: str = "",
) -> Classification:
    """Преобразует валидированный ответ модели в вердикт воркера.

    Приоритет выводится из категории (:data:`PRIORITY_BY_CATEGORY`), поэтому
    модель не может «попросить» дорогую ветку суммаризации для мусора.
    """
    category = payload.category
    priority = PRIORITY_BY_CATEGORY.get(category, PRIORITY_LOW)
    text = normalize_whitespace(reason or payload.summary)
    return Classification(
        category=category,
        priority=priority,
        reason=truncate_text(text, MAX_REASON_CHARS),
        summary=payload.summary,
        spam_tag=payload.spam_tag,
        spam_url=payload.spam_url,
    )


def build_email_record(
    account_id: int,
    envelope: EmailEnvelope,
    *,
    classification: Classification | None = None,
    status: str = "classified",
    is_deleted: bool = False,
    ai_model: str | None = None,
) -> EmailRecord:
    """Собирает :class:`EmailRecord` из заголовков и (опционально) вердикта."""
    return EmailRecord(
        account_id=account_id,
        external_id=envelope.external_id,
        message_id=envelope.message_id or None,
        sender=envelope.address,
        sender_name=envelope.sender_name,
        subject=envelope.subject,
        received_at=parse_received_at(envelope.received_at),
        category=classification.category if classification else None,
        priority=classification.priority if classification else None,
        summary=(classification.summary or None) if classification else None,
        spam_tag=classification.spam_tag if classification else None,
        spam_url=classification.spam_url if classification else None,
        status=status,
        is_deleted=is_deleted,
        ai_model=ai_model,
    )


def mask_dsn(dsn: str) -> str:
    """Скрывает пароль в DSN: ``postgresql://user:***@host:5432/db``."""
    text = (dsn or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
    except ValueError:
        return "***"
    if not parts.scheme:
        return "***"
    netloc = parts.hostname or ""
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    if parts.username:
        netloc = f"{parts.username}:***@{netloc}"
    return urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def load_env_file(path: Path | None = None, *, override: bool = False) -> int:
    """Загружает ``.env`` в ``os.environ`` (по умолчанию не перетирает окружение).

    ``python-dotenv`` используется, если установлен; иначе работает встроенный
    парсер (``KEY=VALUE``, комментарии ``#``, кавычки). Значения не логируются:
    в диагностику попадают только имена переменных.

    :param path: путь к файлу; по умолчанию ``<project root>/.env``.
    :param override: ``True`` - перетирать уже заданные переменные Windows.
    :returns: количество загруженных переменных (0 - файла нет или он пуст).
    """
    candidate = Path(path) if path is not None else PROJECT_ROOT / ".env"
    if not candidate.is_file():
        return 0
    try:
        from dotenv import load_dotenv  # noqa: PLC0415 - опциональная зависимость
    except ImportError:
        return _load_env_file_fallback(candidate, override=override)
    try:
        loaded = load_dotenv(candidate, override=override)
    except OSError as exc:  # нечитаемый файл не должен ронять воркер
        log(f"ENV: не удалось прочитать {candidate.name}: {exc}")
        return 0
    return 1 if loaded else 0


def _load_env_file_fallback(path: Path, *, override: bool) -> int:
    """Минимальный парсер ``.env`` на случай отсутствия ``python-dotenv``."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        log(f"ENV: не удалось прочитать {path.name}: {exc}")
        return 0
    loaded = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = ENV_LINE_RE.match(line)
        if match is None:
            continue
        name, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if override or not os.environ.get(name):
            os.environ[name] = value
            loaded += 1
    return loaded


def resolve_env_value(value: str | None, *, field_name: str, required: bool = False) -> str:
    """Разворачивает значение вида ``ENV_NAME`` в значение из ``os.environ``.

    В конфиге хранятся только имена переменных: литеральный секрет в JSON
    запрещён правилами безопасности проекта. Пустая строка - штатный результат,
    если переменная не задана (провайдер будет пропущен с предупреждением).

    :raises ConfigError: ``required=True`` и переменная окружения не задана.
    """
    text = "" if value is None else str(value).strip()
    if not text:
        if required:
            raise ConfigError(f"{field_name}: value is empty")
        return ""
    if ENV_NAME_RE.match(text):
        resolved = os.environ.get(text, "").strip()
        if not resolved and required:
            raise ConfigError(f"{field_name}: environment variable {text} is not set")
        return resolved
    return text


def as_text(value: Any, default: str = "") -> str:
    """Приводит значение JSON к строке (``None`` -> ``default``)."""
    if value is None:
        return default
    return str(value).strip()


def as_int(value: Any, default: int, *, minimum: int = 1) -> int:
    """Приводит значение JSON к целому с нижней границей."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, number)


def as_float(value: Any, default: float, *, minimum: float = 0.1) -> float:
    """Приводит значение JSON к числу с плавающей точкой и нижней границей."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, number)


def as_bool(value: Any, default: bool) -> bool:
    """Приводит значение JSON к ``bool`` (строки ``"false"``/``"0"`` дают ``False``)."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() not in {"", "0", "false", "no", "off"}


def as_str_tuple(value: Any, default: Sequence[str] = ()) -> tuple[str, ...]:
    """Приводит JSON-массив строк к кортежу (строки обрезаются, пустые отброшены)."""
    if isinstance(value, str):
        items: Iterable[Any] = [value]
    elif isinstance(value, (list, tuple)):
        items = value
    else:
        return tuple(default)
    result = tuple(text for text in (as_text(item) for item in items) if text)
    return result or tuple(default)

def normalize_whitespace(text: str) -> str:
    """Нормализует переводы строк и пробелы: важно для стабильных превью и хэшей."""
    if not text:
        return ""
    unified = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    unified = INLINE_SPACES_RE.sub(" ", unified)
    unified = "\n".join(line.rstrip() for line in unified.split("\n"))
    return MANY_NEWLINES_RE.sub("\n\n", unified).strip()


def normalize_address(value: str) -> str:
    """Возвращает e-mail в нижнем регистре без отображаемого имени."""
    _, address = parseaddr(value or "")
    return (address or "").strip().lower()


def extract_email_address(value: str) -> str:
    """Извлекает адрес из строки ``Имя <user@host>`` (нижний регистр)."""
    return normalize_address(value)


def is_whitelisted(
    address: str,
    white_list: Iterable[str],
    domains: Iterable[str] = (),
) -> bool:
    """Проверяет адрес по белому списку адресов и доменов.

    Домен ``example.com`` покрывает и поддомены (``mail.example.com``), чтобы
    корпоративная почта не требовала перечислять каждый хост.
    """
    normalized = normalize_address(address)
    if not normalized:
        return False
    if normalized in {normalize_address(item) for item in white_list}:
        return True
    _, _, domain = normalized.partition("@")
    if not domain:
        return False
    for item in domains:
        candidate = as_text(item).lower().lstrip("@")
        if candidate and (domain == candidate or domain.endswith(f".{candidate}")):
            return True
    return False


def decode_mime_header(value: Any) -> str:
    """Декодирует заголовок вида ``=?utf-8?B?...?=`` в читаемый текст."""
    if value is None:
        return ""
    raw = str(value)
    try:
        decoded = str(make_header(decode_header(raw)))
    except (UnicodeDecodeError, LookupError, ValueError):
        decoded = raw
    return normalize_whitespace(decoded)[:MAX_HEADER_CHARS]


def decode_bytes(data: bytes, charset: str = "utf-8") -> str:
    """Декодирует байты письма: заявленная кодировка, затем UTF-8/CP1251/Latin-1."""
    for candidate in (charset, "utf-8", "cp1251", "latin-1"):
        if not candidate:
            continue
        try:
            return data.decode(candidate, errors="replace")
        except LookupError:
            continue
    return data.decode("utf-8", errors="replace")


def strip_html(text: str) -> str:
    """Убирает скрипты/стили и теги из HTML-письма, оставляя читаемый текст."""
    without_scripts = HTML_SCRIPT_RE.sub(" ", text)
    without_tags = HTML_TAG_RE.sub(" ", without_scripts)
    return normalize_whitespace(html.unescape(without_tags))


def parse_search_lines(lines: Iterable[Any]) -> list[str]:
    """Разбирает ответ ``SEARCH``: возвращает номера писем в порядке сервера."""
    numbers: list[str] = []
    for line in lines:
        if isinstance(line, (bytes, bytearray)):
            chunk = bytes(line).decode("ascii", "ignore")
        else:
            chunk = str(line)
        for token in chunk.split():
            if token.isdigit():
                numbers.append(token)
    return numbers


def parse_fetch_literal(lines: Iterable[Any]) -> bytes:
    """Возвращает первый литерал ответа ``FETCH`` (метаданные и ``)`` отброшены)."""
    for line in lines:
        if not isinstance(line, (bytes, bytearray)):
            continue
        payload = bytes(line)
        if not payload or payload == b")" or FETCH_META_RE.match(payload):
            continue
        return payload
    return b""


def decode_imap_utf7(value: str) -> str:
    """Декодирует имя папки IMAP из modified UTF-7 (RFC 3501, §5.1.3).

    Mail.ru отдаёт кириллицу как ``&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-``;
    после декодирования в ``mail_folders.name`` попадает читаемое имя, а
    исходная строка сохраняется в ``raw_name`` для отладки.
    """
    text = value or ""
    if "&" not in text:
        return text
    result: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char != "&":
            result.append(char)
            index += 1
            continue
        end = text.find("-", index)
        if end == -1:  # незакрытая последовательность - оставляем как есть
            result.append(text[index:])
            break
        chunk = text[index + 1 : end]
        if not chunk:
            result.append("&")
        else:
            b64 = chunk.replace(",", "/")  # RFC 3501: ',' вместо '/'
            padded = b64 + "=" * (-len(b64) % 4)
            try:
                decoded = base64.b64decode(padded, validate=False)
                result.append(decoded.decode("utf-16-be", errors="replace"))
            except (binascii.Error, UnicodeDecodeError, ValueError):
                result.append(text[index : end + 1])
        index = end + 1
    return "".join(result)


def unquote_imap_string(value: str) -> str:
    """Снимает кавычки IMAP-строки и раскрывает экранирование."""
    text = (value or "").strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]
    return text.replace('\\"', '"').replace("\\\\", "\\")


def parse_list_line(line: Any) -> FolderInfo | None:
    """Разбирает одну строку ответа ``LIST`` в :class:`FolderInfo`.

    Допускает префикс ``* LIST`` и строки байтами; строки без флагов или
    разделителя (метаданные сервера) отбрасываются.
    """
    if isinstance(line, (bytes, bytearray)):
        text = bytes(line).decode("utf-8", errors="replace")
    else:
        text = str(line)
    text = LIST_PREFIX_RE.sub("", text.strip())
    match = LIST_LINE_RE.match(text)
    if match is None:
        return None
    flags = tuple(token.lstrip("\\").lower() for token in match.group("flags").split() if token)
    delimiter_raw = match.group("delimiter")
    delimiter = "" if delimiter_raw.upper() == "NIL" else unquote_imap_string(delimiter_raw)
    raw_name = unquote_imap_string(match.group("name"))
    if not raw_name:
        return None
    special_use = next(
        (
            flag
            for flag in flags
            if flag in {"sent", "drafts", "trash", "junk", "archive", "flagged"}
        ),
        None,
    )
    return FolderInfo(
        name=decode_imap_utf7(raw_name),
        raw_name=raw_name,
        delimiter=delimiter,
        flags=flags,
        special_use=special_use,
        is_selectable="noselect" not in flags,
    )


def decode_partial(raw: bytes, *, charset: str = "utf-8", transfer_encoding: str = "") -> str:
    """Декодирует фрагмент тела письма (первые N байт), полученный частичным FETCH.

    Фрагмент multipart-письма может начинаться с ``--boundary``: служебная часть
    до первого пустого строки отбрасывается, чтобы в превью не попал boundary.
    """
    if not raw:
        return ""
    encoding = (transfer_encoding or "").strip().lower()
    data = raw
    if encoding == "base64":
        padded = data + b"=" * (-len(data) % 4)
        try:
            data = base64.b64decode(padded, validate=False)
        except (binascii.Error, ValueError):
            data = b""
    elif encoding in {"quoted-printable", "quoted_printable"}:
        data = quopri.decodestring(data)
    text = normalize_whitespace(decode_bytes(data, charset))
    if text.startswith("--"):
        _, separator, rest = text.partition("\n\n")
        if separator:
            text = rest
    return normalize_whitespace(text)

def truncate_text(text: str, limit: int, *, suffix: str = "…") -> str:
    """Обрезает текст до ``limit`` символов по границе слова (для превью и алертов)."""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    cut = text[: max(limit - len(suffix), 0)]
    if len(text) > len(cut) and not text[len(cut)].isspace() and " " in cut:
        cut = cut[: cut.rfind(" ")]
    return f"{cut.rstrip()}{suffix}"


def extract_body_text(raw: bytes) -> str:
    """Извлекает читаемый текст из полного MIME-письма (``text/plain`` приоритетно)."""
    if not raw:
        return ""
    try:
        message: Message = BytesParser().parsebytes(raw)
    except (ValueError, TypeError, IndexError):  # битое письмо не должно ронять воркер
        return normalize_whitespace(decode_bytes(raw, "utf-8"))

    plain_parts: list[str] = []
    rich_parts: list[str] = []
    for part in message.walk():
        if part.is_multipart() or part.get_content_maintype() != "text":
            continue
        if part.get_filename():  # вложения пропускаем: они не нужны классификатору
            continue
        payload = part.get_payload(decode=True)
        if not isinstance(payload, (bytes, bytearray)):
            continue
        text = decode_bytes(bytes(payload), part.get_content_charset() or "utf-8")
        if part.get_content_type() == "text/html":
            rich_parts.append(strip_html(text))
        else:
            plain_parts.append(normalize_whitespace(text))

    body = normalize_whitespace("\n".join(plain_parts or rich_parts))
    if body:
        return body
    payload = message.get_payload(decode=True)
    if isinstance(payload, (bytes, bytearray)):
        return normalize_whitespace(decode_bytes(bytes(payload), message.get_content_charset() or "utf-8"))
    return ""


def build_envelope(headers_raw: bytes, seq: str) -> EmailEnvelope:
    """Собирает :class:`EmailEnvelope` из сырых заголовков письма."""
    headers: Message = BytesHeaderParser().parsebytes(headers_raw or b"")
    sender_name, address = parseaddr(str(headers.get("From", "") or ""))

    received_at = ""
    raw_date = headers.get("Date")
    if raw_date:
        try:
            moment = parsedate_to_datetime(str(raw_date))
        except (TypeError, ValueError, IndexError):
            moment = None
        if moment is not None:
            received_at = moment.astimezone(MSK_FALLBACK).isoformat(timespec="seconds")
    if not received_at:
        received_at = datetime.now(tz=MSK_FALLBACK).isoformat(timespec="seconds")

    return EmailEnvelope(
        seq=seq,
        sender_name=decode_mime_header(sender_name),
        address=normalize_address(address),
        subject=decode_mime_header(headers.get("Subject", "")),
        message_id=str(headers.get("Message-ID", "") or "").strip().strip("<>"),
        received_at=received_at,
        content_type=headers.get_content_type() or "text/plain",
        charset=headers.get_content_charset() or "utf-8",
        transfer_encoding=str(headers.get("Content-Transfer-Encoding", "") or ""),
    )


def parse_classification(raw: str) -> Classification:
    """Разбирает ответ модели по строгой Pydantic-схеме :class:`EmailClassification`.

    Markdown-обёртка и словесный шум вокруг JSON отбрасываются, но сам JSON
    обязан содержать ``category`` из контракта. Поле ``reason`` поддержано как
    legacy-алиас для ``summary`` (старые промпты и внешние классификаторы).

    :raises AiAnalysisError: JSON отсутствует, битый или нарушает схему.
    """
    text = (raw or "").strip()
    if not text:
        raise AiAnalysisError("empty model response")
    text = _FENCE_RE.sub("", text).strip()
    match = JSON_OBJECT_RE.search(text)
    if match is None:
        raise AiAnalysisError(f"no JSON object in response: {text[:120]!r}")
    try:
        payload: Any = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise AiAnalysisError(f"invalid JSON: {exc.msg}") from exc
    if not isinstance(payload, Mapping):
        raise AiAnalysisError("JSON root is not an object")
    try:
        parsed = EmailClassification.model_validate(dict(payload))
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        raise AiAnalysisError(
            f"schema violation at {first.get('loc')}: {first.get('msg')}"
        ) from exc
    return classification_from_model(parsed, reason=as_text(payload.get("reason")))


def build_payload(
    *,
    provider: ProviderSettings,
    envelope: EmailEnvelope,
    action: str,
    category: str,
    priority: str,
    reason: str,
    text: str,
    summary: str | None = None,
    spam_tag: str | None = None,
    spam_url: str | None = None,
) -> dict[str, Any]:
    """Формирует JSON-уведомление для C++ ядра.

    ``chat_id`` в схеме ядра - идентификатор диалога; для почты это ``id``
    провайдера (ящика), чтобы дедупликация ядра работала по паре
    ``channel=email`` + ``chat_id`` + ``external_id``. Для строк из
    ``mail_accounts`` провайдер получает ``account_id`` и адрес ящика.
    """
    return {
        "source": "mail_worker",
        "channel": "email",
        "provider": provider.id,
        "chat_id": provider.id,
        "account_id": provider.account_id,
        "external_id": envelope.external_id,
        "sender": envelope.address,
        "sender_name": envelope.sender_name,
        "subject": envelope.subject,
        "received_at": envelope.received_at,
        "category": category,
        "priority": priority,
        "reason": reason,
        "action": action,
        "summary": summary,
        "spam_tag": spam_tag,
        "spam_url": spam_url,
        "text": text,
        "text_length": len(text),
    }

MODEL_ALIASES: Mapping[str, str] = {
    # В задании модель названа deepseek-reasoning; фактический id в DeepSeek API -
    # deepseek-reasoner (DeepSeek-R1). Алиасы избавляют от 400 Bad Request.
    "deepseek-reasoning": "deepseek-reasoner",
    "deepseek-r1": "deepseek-reasoner",
    "deepseek-v3": "deepseek-chat",
}


def normalize_model_name(name: str, default: str) -> str:
    """Приводит имя модели к id DeepSeek API (алиасы ``deepseek-reasoning`` и др.)."""
    text = as_text(name, default) or default
    return MODEL_ALIASES.get(text.lower(), text)


def load_config_document(path: Path) -> Mapping[str, Any]:
    """Читает ``config/orchestrator.json`` как UTF-8 (BOM допускается).

    :raises ConfigError: файл отсутствует, не читается, не UTF-8 или не JSON-объект.
    """
    try:
        raw = path.read_bytes().decode("utf-8-sig")
    except FileNotFoundError as exc:
        raise ConfigError(f"config file not found: {path}") from exc
    except OSError as exc:
        raise ConfigError(f"cannot read config {path}: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise ConfigError(f"config {path} is not valid UTF-8: {exc}") from exc
    try:
        document: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"config {path}: invalid JSON at line {exc.lineno}: {exc.msg}") from exc
    if not isinstance(document, Mapping):
        raise ConfigError(f"config {path}: root must be a JSON object")
    return document


def extract_mail_worker_block(document: Mapping[str, Any]) -> Mapping[str, Any]:
    """Достаёт блок ``workers.mail_worker``.

    Поддерживаются три формы: объект ``workers`` (актуальная схема), массив
    ``workers`` с элементом ``id = mail_worker`` (старая схема) и плоский
    ключ ``mail_worker`` в корне (резерв для тестовых конфигов).

    :raises ConfigError: блок не найден или имеет неверный тип.
    """
    workers = document.get("workers")
    block: Any = None
    if isinstance(workers, Mapping):
        block = workers.get("mail_worker")
    elif isinstance(workers, (list, tuple)):
        for item in workers:
            if isinstance(item, Mapping) and as_text(item.get("id")) == "mail_worker":
                block = item
                break
    if block is None:
        block = document.get("mail_worker")
    if not isinstance(block, Mapping):
        raise ConfigError("config: block 'workers.mail_worker' is missing")
    return block


def parse_ai_settings(raw: Any) -> AISettings:
    """Разбирает подблок ``ai``: модели, таймауты, повторы и лимит токенов."""
    block = raw if isinstance(raw, Mapping) else {}
    key_ref = as_text(block.get("api_key"))
    max_tokens = as_int(block.get("max_tokens"), DEFAULT_AI_MAX_TOKENS, minimum=64)
    return AISettings(
        base_url=as_text(block.get("base_url"), "https://api.deepseek.com") or "https://api.deepseek.com",
        api_key=resolve_env_value(key_ref, field_name="ai.api_key") if key_ref else "",
        classifier_model=normalize_model_name(as_text(block.get("classifier_model")), "deepseek-chat"),
        summarizer_model=normalize_model_name(as_text(block.get("summarizer_model")), "deepseek-reasoner"),
        fallback_model=normalize_model_name(
            as_text(block.get("fallback_model")), DEFAULT_FALLBACK_MODEL
        ),
        classify_chars=as_int(block.get("classify_chars"), DEFAULT_CLASSIFY_CHARS, minimum=80),
        json_mode=as_bool(block.get("json_mode"), True),
        timeout_sec=as_float(block.get("timeout_sec"), DEFAULT_AI_TIMEOUT_SEC),
        retry_attempts=as_int(
            block.get("retry_attempts"), DEFAULT_AI_RETRY_ATTEMPTS, minimum=1
        ),
        retry_base_delay_sec=as_float(
            block.get("retry_base_delay_sec"), DEFAULT_AI_RETRY_BASE_DELAY_SEC, minimum=0.01
        ),
        max_tokens=min(max_tokens, MAX_AI_TOKENS_CAP),
        summary_max_tokens=as_int(
            block.get("summary_max_tokens"), DEFAULT_SUMMARY_MAX_TOKENS, minimum=128
        ),
    )


def extract_storage_block(document: Mapping[str, Any]) -> Mapping[str, Any]:
    """Возвращает блок ``storage`` конфига (или пустой словарь)."""
    storage = document.get("storage")
    return storage if isinstance(storage, Mapping) else {}


def parse_database_settings(document: Mapping[str, Any]) -> DatabaseSettings:
    """Разбирает ``storage.postgres``: DSN только из окружения по ``dsn_env``.

    Литеральный DSN в конфиге запрещён (это секрет), допускается имя
    переменной: ``"dsn_env": "DATABASE_URL"`` или ``"dsn": "ENV_DATABASE_URL"``.

    :raises ConfigError: в конфиге оказался литеральный DSN.
    """
    storage = extract_storage_block(document)
    raw_postgres = storage.get("postgres")
    pg: Mapping[str, Any] = raw_postgres if isinstance(raw_postgres, Mapping) else {}
    dsn_env = as_text(pg.get("dsn_env"), DEFAULT_DATABASE_URL_ENV) or DEFAULT_DATABASE_URL_ENV
    dsn_ref = as_text(pg.get("dsn"))
    if dsn_ref:
        if not ENV_NAME_RE.match(dsn_ref):
            raise ConfigError(
                "storage.postgres.dsn must be an ENV_* variable name "
                "(literal DSN with a password is forbidden)"
            )
        dsn_env = dsn_ref
    dsn = os.environ.get(dsn_env, "").strip()
    min_size = as_int(pg.get("min_pool_size"), DEFAULT_DB_MIN_POOL, minimum=1)
    max_size = max(as_int(pg.get("max_pool_size"), DEFAULT_DB_MAX_POOL, minimum=1), min_size)
    migrations = as_str_tuple(pg.get("migrations"), (DEFAULT_MIGRATION_PATH,))
    return DatabaseSettings(
        dsn=dsn,
        dsn_env=dsn_env,
        min_size=min_size,
        max_size=max_size,
        command_timeout_sec=as_float(
            pg.get("command_timeout_sec"), DEFAULT_DB_COMMAND_TIMEOUT_SEC
        ),
        connect_timeout_sec=as_float(
            pg.get("connect_timeout_sec"), DEFAULT_DB_CONNECT_TIMEOUT_SEC
        ),
        migrations_path=migrations[0] if migrations else DEFAULT_MIGRATION_PATH,
    )


def parse_core_settings(raw: Any) -> CoreSettings:
    """Разбирает подблок ``core``: адрес C++ ядра и политику повторов.

    :raises ConfigError: URL не начинается с ``http://`` или ``https://``.
    """
    block = raw if isinstance(raw, Mapping) else {}
    http_url = as_text(block.get("http_url"), DEFAULT_CORE_URL) or DEFAULT_CORE_URL
    if not http_url.lower().startswith(("http://", "https://")):
        raise ConfigError(f"core.http_url must start with http:// or https://, got {http_url!r}")
    notify_path = as_text(block.get("notify_path"), DEFAULT_NOTIFY_PATH) or DEFAULT_NOTIFY_PATH
    return CoreSettings(
        http_url=http_url,
        notify_path=notify_path,
        timeout_sec=as_float(block.get("timeout_sec"), 10.0),
        retries=as_int(block.get("retries"), 2, minimum=0),
    )


def parse_limits(raw: Any) -> Limits:
    """Разбирает подблок ``limits``: сколько писем и символов обрабатывать."""
    block = raw if isinstance(raw, Mapping) else {}
    return Limits(
        max_messages_per_poll=as_int(block.get("max_messages_per_poll"), DEFAULT_MAX_MESSAGES),
        snippet_bytes=as_int(block.get("snippet_bytes"), DEFAULT_SNIPPET_BYTES, minimum=512),
        body_chars=as_int(block.get("body_chars"), DEFAULT_BODY_CHARS, minimum=1000),
        summary_chars=as_int(block.get("summary_chars"), DEFAULT_SUMMARY_CHARS, minimum=200),
        max_delivery_attempts=as_int(
            block.get("max_delivery_attempts"), DEFAULT_MAX_DELIVERY_ATTEMPTS
        ),
    )


def parse_reconnect_settings(raw: Any) -> ReconnectSettings:
    """Разбирает подблок ``reconnect``: стартовая задержка, потолок и множитель."""
    block = raw if isinstance(raw, Mapping) else {}
    initial = as_float(block.get("initial_delay_sec"), 5.0, minimum=0.5)
    maximum = max(as_float(block.get("max_delay_sec"), 300.0, minimum=initial), initial)
    return ReconnectSettings(
        initial_delay_sec=initial,
        max_delay_sec=maximum,
        backoff_factor=max(1.0, as_float(block.get("backoff_factor"), 1.7)),
    )

def parse_provider(raw: Any, index: int) -> ProviderSettings:
    """Разбирает один элемент ``providers[]``.

    Логин и пароль разворачиваются из окружения; если переменная не задана,
    провайдер остаётся в конфиге, но будет пропущен с предупреждением
    (``has_credentials == False``), чтобы один незаполненный ящик не блокировал
    остальные.

    :raises ConfigError: элемент не объект или не задан ``imap_host``.
    """
    if not isinstance(raw, Mapping):
        raise ConfigError(f"providers[{index}]: must be an object")
    provider_id = as_text(raw.get("id")) or f"provider{index + 1}"
    host = as_text(raw.get("imap_host"))
    if not host:
        raise ConfigError(f"providers[{provider_id}]: imap_host is required")

    username_ref = as_text(raw.get("username"))
    password_ref = as_text(raw.get("password"))
    username = (
        resolve_env_value(username_ref, field_name=f"providers[{provider_id}].username")
        if username_ref
        else ""
    )
    password = (
        resolve_env_value(password_ref, field_name=f"providers[{provider_id}].password")
        if password_ref
        else ""
    )
    white_list = frozenset(
        address
        for address in (normalize_address(item) for item in as_str_tuple(raw.get("white_list")))
        if address
    )
    domains = frozenset(
        candidate
        for candidate in (
            as_text(item).lower().lstrip("@") for item in as_str_tuple(raw.get("white_list_domains"))
        )
        if candidate
    )
    return ProviderSettings(
        id=provider_id,
        host=host,
        port=as_int(raw.get("imap_port"), 993, minimum=1),
        use_ssl=as_bool(raw.get("use_ssl"), True),
        username=username,
        password=password,
        mailbox=as_text(raw.get("mailbox"), "INBOX") or "INBOX",
        search=as_str_tuple(raw.get("search"), ("UNSEEN",)),
        poll_interval_sec=as_float(raw.get("poll_interval_sec"), 300.0, minimum=5.0),
        connect_timeout_sec=as_float(raw.get("connect_timeout_sec"), 15.0, minimum=1.0),
        command_timeout_sec=as_float(raw.get("command_timeout_sec"), 30.0, minimum=1.0),
        max_messages=as_int(raw.get("max_messages_per_poll"), DEFAULT_MAX_MESSAGES),
        white_list=white_list,
        white_list_domains=domains,
        enabled=as_bool(raw.get("enabled"), True),
    )


def load_settings(
    path: Path = DEFAULT_CONFIG,
    *,
    only_providers: Sequence[str] = (),
) -> Settings:
    """Читает и валидирует блок ``workers.mail_worker`` из конфига.

    :param only_providers: ограничить набор ящиков (флаг ``--provider``).
    :raises ConfigError: битый конфиг, пустой список ящиков, неизвестный ``--provider``.
    """
    document = load_config_document(path)
    block = extract_mail_worker_block(document)
    raw_providers = block.get("providers")
    if not isinstance(raw_providers, (list, tuple)):
        raise ConfigError("config: workers.mail_worker.providers must be an array")
    providers = [parse_provider(item, index) for index, item in enumerate(raw_providers)]

    wanted = {item.strip().lower() for item in only_providers if str(item).strip()}
    if wanted:
        known = {provider.id.lower() for provider in providers}
        unknown = wanted - known
        if unknown:
            raise ConfigError(f"unknown provider id(s): {', '.join(sorted(unknown))}")
        providers = [provider for provider in providers if provider.id.lower() in wanted]
    if not providers:
        raise ConfigError("config: workers.mail_worker.providers is empty")

    return Settings(
        config_path=path,
        enabled=as_bool(block.get("enabled"), True),
        ai=parse_ai_settings(block.get("ai")),
        core=parse_core_settings(block.get("core")),
        limits=parse_limits(block.get("limits")),
        reconnect=parse_reconnect_settings(block.get("reconnect")),
        providers=tuple(providers),
        database=parse_database_settings(document),
    )

CLASSIFIER_SYSTEM_PROMPT: str = (
    "Ты - сортировщик входящей почты инженера-программиста. "
    "Верни СТРОГО один JSON-объект, без markdown и без пояснений вокруг: "
    '{"category": "WHITELIST|CRITICAL|VACANCY|SPAM_VALUABLE|SPAM", '
    '"summary": "1-2 предложения по-русски", '
    '"spam_tag": "promo|sale|coupon|null", '
    '"spam_url": "http(s)-ссылка или null"}. '
    "WHITELIST - отправитель из белого списка; CRITICAL - важное личное или рабочее "
    "письмо, требующее действия; VACANCY - вакансии и HR; SPAM_VALUABLE - полезные "
    "рассылки, скидки, промокоды, анонсы; SPAM - мусор. "
    "Поля spam_tag и spam_url заполняй только для SPAM_VALUABLE, иначе null."
)

SUMMARY_SYSTEM_PROMPT: str = (
    "Ты - аналитик почты. Сделай краткую смысловую выжимку письма для занятого инженера: "
    "3-5 пунктов, только факты, сроки, суммы и требуемые действия. Без вступлений и воды."
)

RETRY_INSTRUCTION: str = (
    "Предыдущий ответ нарушил контракт. Верни ТОЛЬКО JSON-объект с полями "
    "category, summary, spam_tag, spam_url. Категория строго из "
    "WHITELIST, CRITICAL, VACANCY, SPAM_VALUABLE, SPAM; summary - строка; "
    "spam_tag и spam_url - строка или null."
)


def completion_text(response: Any) -> str:
    """Достаёт текст ответа модели (``choices[0].message.content``).

    Поддерживает и объекты ``openai``, и словари (используется в офлайн-тестах).

    :raises AiAnalysisError: ответ пустой или не содержит ``choices``.
    """
    choices = getattr(response, "choices", None)
    if choices is None and isinstance(response, Mapping):
        choices = response.get("choices")
    if not choices:
        raise AiAnalysisError("model response has no choices")
    first = choices[0]
    message = getattr(first, "message", None)
    if message is None and isinstance(first, Mapping):
        message = first.get("message")
    if message is None:
        raise AiAnalysisError("model response has no message")
    content = getattr(message, "content", None)
    if content is None and isinstance(message, Mapping):
        content = message.get("content")
    if isinstance(content, (list, tuple)):
        parts: list[str] = []
        for item in content:
            text = getattr(item, "text", None)
            if text is None and isinstance(item, Mapping):
                text = item.get("text")
            if text:
                parts.append(str(text))
        content = "".join(parts)
    text = str(content or "").strip()
    if not text:
        raise AiAnalysisError("model returned empty content")
    return text[:MAX_AI_RESPONSE_CHARS]

async def request_chat(
    client: Any,
    settings: AISettings,
    model: str,
    messages: Sequence[Mapping[str, str]],
    *,
    max_tokens: int,
    json_mode: bool,
    fallback_model: str | None = None,
) -> str:
    """Запрос к модели: таймаут 15 с, 3 повтора и fallback-модель.

    Стоимость контролируется тремя параметрами: ``max_tokens`` (жёсткий бюджет
    ответа), ``retry_attempts`` (число попыток) и ``timeout_sec`` (зависший
    запрос не держит ящик). Задержка между попытками растёт экспоненциально
    (``base * 2^(n-1)``, потолок :data:`MAX_AI_RETRY_DELAY_SEC`); после
    исчерпания попыток основной модели запрос уходит на резервную.

    :raises AiAnalysisError: ни основная, ни резервная модель не ответили.
    """
    fallback = normalize_model_name(fallback_model or settings.fallback_model, model)
    candidates = [model]
    if fallback and fallback != model:
        candidates.append(fallback)
    attempts = max(1, settings.retry_attempts)
    errors: list[str] = []
    for index, candidate in enumerate(candidates):
        for attempt in range(1, attempts + 1):
            try:
                return await _request_chat_once(
                    client,
                    settings,
                    candidate,
                    messages,
                    max_tokens=max_tokens,
                    json_mode=json_mode,
                )
            except AiAnalysisError as exc:
                errors.append(f"{candidate}#{attempt}: {exc}")
                if attempt < attempts:
                    delay = min(
                        settings.retry_base_delay_sec * (2 ** (attempt - 1)),
                        MAX_AI_RETRY_DELAY_SEC,
                    )
                    log(
                        f"ИИ: {candidate} попытка {attempt}/{attempts} не удалась "
                        f"({exc}); повтор через {delay:g}с"
                    )
                    await asyncio.sleep(delay)
        if index + 1 < len(candidates):
            log(f"ИИ: модель {candidate} недоступна, переключаюсь на резервную {candidates[index + 1]}")
    raise AiAnalysisError(
        f"all models failed after {attempts} attempt(s): {'; '.join(errors[-4:])}"
    )


async def _request_chat_once(
    client: Any,
    settings: AISettings,
    model: str,
    messages: Sequence[Mapping[str, str]],
    *,
    max_tokens: int,
    json_mode: bool,
) -> str:
    """Один запрос к модели с жёстким таймаутом и откатом JSON-режима.

    Если провайдер не поддерживает ``response_format={"type": "json_object"}``,
    запрос повторяется без него: это сохраняет совместимость с локальными
    OpenAI-совместимыми серверами (Ollama и др.).

    :raises AiAnalysisError: таймаут, ошибка API или пустой ответ модели.
    """
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": list(messages),
        "max_tokens": max_tokens,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    async def call(params: Mapping[str, Any]) -> Any:
        return await asyncio.wait_for(
            client.chat.completions.create(**params), timeout=settings.timeout_sec
        )

    try:
        response = await call(kwargs)
    except asyncio.TimeoutError as exc:
        raise AiAnalysisError(f"{model}: timeout after {settings.timeout_sec:g}s") from exc
    except Exception as exc:  # сеть, 4xx/5xx, отказ в JSON-режиме
        if not json_mode:
            raise AiAnalysisError(f"{model}: {exc}") from exc
        log(f"ИИ: модель {model} не приняла JSON-режим ({exc}); повтор без response_format")
        fallback_kwargs = {key: value for key, value in kwargs.items() if key != "response_format"}
        try:
            response = await call(fallback_kwargs)
        except asyncio.TimeoutError as retry_exc:
            raise AiAnalysisError(f"{model}: timeout after {settings.timeout_sec:g}s") from retry_exc
        except Exception as retry_exc:
            raise AiAnalysisError(f"{model}: {retry_exc}") from retry_exc
    return completion_text(response)


async def classify_email_via_ai(
    client: Any,
    settings: AISettings,
    envelope: EmailEnvelope,
    snippet: str,
) -> Classification:
    """Шаг 2 каскада: модель классифицирует письмо по заголовкам и превью.

    Модель обязана ответить JSON по схеме :class:`EmailClassification`; при
    нарушении контракта делается одна повторная попытка с явным напоминанием
    формата (ошибки API уже обработаны повторами в :func:`request_chat`).

    :raises AiAnalysisError: обе попытки вернули невалидный ответ.
    """
    preview = truncate_text(normalize_whitespace(snippet), settings.classify_chars, suffix="")
    user_message = (
        f"Отправитель: {envelope.sender_name or '(без имени)'} <{envelope.address}>\n"
        f"Тема: {envelope.subject or '(без темы)'}\n"
        f"Первые {settings.classify_chars} символов тела:\n{preview or '(тело пустое)'}"
    )
    messages: list[dict[str, str]] = [
        {"role": "system", "content": CLASSIFIER_SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    last_error: AiAnalysisError | None = None
    for attempt in (1, 2):
        raw = await request_chat(
            client,
            settings,
            settings.classifier_model,
            messages,
            max_tokens=settings.max_tokens,
            json_mode=settings.json_mode,
            fallback_model=settings.fallback_model,
        )
        try:
            return parse_classification(raw)
        except AiAnalysisError as exc:
            last_error = exc
            log(f"ИИ: попытка {attempt} классификации отклонена: {exc}")
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": RETRY_INSTRUCTION})
    raise AiAnalysisError(f"classification failed after 2 attempts: {last_error}")

async def summarize_email_via_ai(
    client: Any,
    settings: AISettings,
    envelope: EmailEnvelope,
    body: str,
    *,
    body_chars: int,
    summary_chars: int,
) -> str:
    """Шаг 3 каскада: тяжёлая модель DeepSeek-R1 делает выжимку важного письма.

    :raises AiAnalysisError: ошибка API или пустой ответ модели.
    """
    text = truncate_text(body, body_chars, suffix="")
    if not text:
        return ""
    user_message = (
        f"Отправитель: {envelope.sender_name or '(без имени)'} <{envelope.address}>\n"
        f"Тема: {envelope.subject or '(без темы)'}\n"
        f"Дата: {envelope.received_at}\n\nТекст письма:\n{text}"
    )
    raw = await request_chat(
        client,
        settings,
        settings.summarizer_model,
        [
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        max_tokens=settings.summary_max_tokens,
        json_mode=False,
        fallback_model=settings.classifier_model,
    )
    return truncate_text(normalize_whitespace(raw), summary_chars)


def create_ai_client(settings: AISettings) -> Any:
    """Создаёт ``AsyncOpenAI`` для каскада DeepSeek.

    :raises ConfigError: пакет ``openai`` не установлен.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        raise ConfigError(
            "openai is not installed: run 'uv pip install -r requirements.txt'"
        ) from exc
    return AsyncOpenAI(
        api_key=settings.api_key,
        base_url=settings.base_url,
        timeout=settings.timeout_sec,
        max_retries=1,
    )


async def close_ai_client(client: Any) -> None:
    """Закрывает ``AsyncOpenAI`` (или совместимый фейк) без исключений наружу."""
    if client is None:
        return
    close = getattr(client, "close", None)
    if not callable(close):
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:  # закрытие не должно ронять воркер при остановке
        log(f"ИИ: ошибка закрытия клиента: {exc}")


class CoreNotifier:
    """Асинхронный POST уведомлений в C++ ядро через ``httpx.AsyncClient``.

    Повторы: только для сетевых ошибок, 5xx и 429; ответы 4xx (кроме 429)
    считаются приглашением исправить контракт и не повторяются.
    """

    def __init__(self, settings: CoreSettings, *, client: Any = None) -> None:
        self._settings = settings
        self._client = client
        self._owns_client = client is None

    async def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            import httpx
        except ImportError as exc:
            raise ConfigError(
                "httpx is not installed: run 'uv pip install -r requirements.txt'"
            ) from exc
        self._client = httpx.AsyncClient(
            timeout=self._settings.timeout_sec,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        return self._client

    async def close(self) -> None:
        """Закрывает внутренний HTTP-клиент (внешний клиент не трогаем)."""
        if self._client is not None and self._owns_client:
            closer = getattr(self._client, "aclose", None)
            if callable(closer):
                try:
                    await closer()
                except Exception as exc:
                    log(f"ЯДРО: ошибка закрытия HTTP-клиента: {exc}")
        self._client = None

    async def send(self, payload: Mapping[str, Any]) -> bool:
        """Отправляет уведомление; ``True`` только при ответе 2xx."""
        client = await self._ensure_client()
        url = self._settings.endpoint
        masked = self._settings.masked_endpoint
        attempts = max(1, self._settings.retries + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = await asyncio.wait_for(
                    client.post(url, json=dict(payload)), timeout=self._settings.timeout_sec
                )
            except asyncio.TimeoutError:
                log(f"ЯДРО: POST {masked} не ответил за {self._settings.timeout_sec:g}с "
                    f"(попытка {attempt}/{attempts})")
            except Exception as exc:  # сеть, DNS, TLS
                log(f"ЯДРО: POST {masked} не удался (попытка {attempt}/{attempts}): {exc}")
            else:
                status = int(getattr(response, "status_code", 0))
                if 200 <= status < 300:
                    log(f"ЯДРО: уведомление доставлено (http={status}, попытка {attempt}/{attempts})")
                    return True
                log(f"ЯДРО: POST {masked} -> http={status} (попытка {attempt}/{attempts})")
                if 400 <= status < 500 and status != 429:
                    return False
            if attempt < attempts:
                await asyncio.sleep(min(2.0 * attempt, 5.0))
        return False

ImapFactory = Callable[[ProviderSettings], Any]
ClassifierFn = Callable[[Any, AISettings, EmailEnvelope, str], Awaitable[Classification]]
SummarizerFn = Callable[[Any, AISettings, EmailEnvelope, str], Awaitable[str]]
SleeperFn = Callable[[float], Awaitable[Any]]


class DatabaseGateway(Protocol):
    """Контракт слоя хранения: воркер не знает про asyncpg и SQL.

    Реализация - :class:`AsyncpgGateway`; тесты подставляют фейк с теми же
    методами, поэтому каскад и запись ``valuable_spam`` проверяются офлайн.
    """

    async def fetch_active_accounts(self) -> list[MailAccount]:
        """Активные ящики (фильтр ``is_active`` выполняет RLS)."""
        ...

    async def fetch_ai_overrides(self) -> Mapping[str, Any]:
        """Лимиты ИИ из ``ai_instructions`` (``model``/``fallback``/``max_tokens``)."""
        ...

    async def save_folders(self, account_id: int, folders: Sequence[FolderInfo]) -> int:
        """UPSERT снимка папок IMAP."""
        ...

    async def upsert_email(self, record: EmailRecord) -> int | None:
        """UPSERT письма; возвращает ``id`` строки ``emails``."""
        ...

    async def save_valuable_spam(self, email_id: int, record: EmailRecord) -> bool:
        """Сохраняет выжимку полезного спама."""
        ...

    async def mark_email_deleted(self, email_id: int) -> None:
        """Помечает письмо удалённым в журнале."""
        ...

    async def touch_account(self, account_id: int, *, error: str | None = None) -> None:
        """Обновляет ``last_sync_at``/``last_error`` ящика."""
        ...


async def create_database_pool(settings: DatabaseSettings) -> Any:
    """Создаёт пул ``asyncpg`` по DSN из окружения.

    :raises ConfigError: ``asyncpg`` не установлен или DSN пуст.
    :raises MailWorkerError: сервер недоступен, неверные учётные данные.
    """
    if not settings.dsn:
        raise ConfigError(f"{settings.dsn_env} is not set: PostgreSQL is unavailable")
    try:
        import asyncpg  # noqa: PLC0415 - тяжёлая опциональная зависимость
    except ImportError as exc:
        raise ConfigError(
            "asyncpg is not installed: run 'uv pip install -r requirements.txt'"
        ) from exc
    try:
        return await asyncpg.create_pool(
            dsn=settings.dsn,
            min_size=settings.min_size,
            max_size=settings.max_size,
            command_timeout=settings.command_timeout_sec,
            timeout=settings.connect_timeout_sec,
        )
    except Exception as exc:  # DNS, TLS, отказ авторизации, таймаут
        raise MailWorkerError(
            f"cannot connect to PostgreSQL ({settings.masked_dsn}): {exc}"
        ) from exc


async def close_database_pool(pool: Any) -> None:
    """Закрывает пул ``asyncpg`` (ошибки только логируются)."""
    if pool is None:
        return
    close = getattr(pool, "close", None)
    if not callable(close):
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:  # остановка не должна падать из-за закрытия
        log(f"БД: ошибка закрытия пула: {exc}")


class AsyncpgGateway:
    """Реализация :class:`DatabaseGateway` поверх пула ``asyncpg``."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def fetch_active_accounts(self) -> list[MailAccount]:
        """Читает ящики; фильтр ``is_active`` выполняет RLS-политика.

        ``WHERE is_active`` намеренно отсутствует: политика
        ``mail_accounts_worker_select_active`` отдаёт только активные строки.
        Проверка ``is_active`` ниже - страховка на случай подключения
        владельцем схемы (RLS обходится) или роли с ``BYPASSRLS``.
        """
        rows = await self._pool.fetch(SQL_FETCH_ACCOUNTS)
        accounts: list[MailAccount] = []
        for row in rows:
            data = dict(row)
            active = as_bool(data.get("is_active"), True)
            account = MailAccount(
                id=int(data["id"]),
                email=as_text(data.get("email")).lower(),
                imap_host=as_text(data.get("imap_host")),
                imap_port=as_int(data.get("imap_port"), 993, minimum=1),
                use_ssl=as_bool(data.get("use_ssl"), True),
                mailbox=as_text(data.get("mailbox"), "INBOX") or "INBOX",
                env_password_key=as_text(data.get("env_password_key")),
                username_env_key=as_text(data.get("username_env_key")),
                poll_interval_sec=as_float(data.get("poll_interval_sec"), 120.0, minimum=5.0),
                max_messages_per_poll=as_int(
                    data.get("max_messages_per_poll"), DEFAULT_MAX_MESSAGES
                ),
                label=as_text(data.get("label")),
                is_active=active,
            )
            if not active:
                log(
                    "БД: RLS не ограничила выборку (владелец схемы или BYPASSRLS?); "
                    f"ящик {account.masked_account} пропущен"
                )
                continue
            accounts.append(account)
        return accounts

    async def fetch_ai_overrides(self) -> Mapping[str, Any]:
        """Читает глобальные лимиты ИИ; первая инструкция по ``priority`` выигрывает."""
        rows = await self._pool.fetch(SQL_FETCH_AI_INSTRUCTIONS)
        overrides: dict[str, Any] = {}
        for row in rows:
            data = dict(row)
            if as_text(data.get("scope")) != "global":
                continue
            if as_text(data.get("scope_key")) not in {"classifier", ""}:
                continue
            model = as_text(data.get("model"))
            fallback = as_text(data.get("fallback_model"))
            if model:
                overrides["model"] = model
            if fallback:
                overrides["fallback_model"] = fallback
            if data.get("max_tokens") is not None:
                try:
                    overrides["max_tokens"] = int(data["max_tokens"])
                except (TypeError, ValueError):
                    pass
            break
        return overrides

    async def save_folders(self, account_id: int, folders: Sequence[FolderInfo]) -> int:
        """UPSERT папок одним ``executemany`` (идемпотентно)."""
        payload = [
            (
                account_id,
                folder.name,
                folder.raw_name or folder.name,
                folder.delimiter or None,
                list(folder.flags),
                folder.special_use,
                folder.is_selectable,
            )
            for folder in folders
            if folder.name
        ]
        if not payload:
            return 0
        await self._pool.executemany(SQL_UPSERT_FOLDER, payload)
        return len(payload)

    async def upsert_email(self, record: EmailRecord) -> int | None:
        """UPSERT письма по ``(account_id, external_id)``."""
        row = await self._pool.fetchrow(
            SQL_UPSERT_EMAIL,
            record.account_id,
            record.external_id,
            record.message_id,
            record.sender,
            record.sender_name,
            record.subject,
            record.received_at,
            record.category,
            record.priority,
            record.summary,
            record.spam_tag,
            record.spam_url,
            record.status,
            record.is_deleted,
            record.ai_model,
        )
        return int(row["id"]) if row is not None else None

    async def save_valuable_spam(self, email_id: int, record: EmailRecord) -> bool:
        """Сохраняет выжимку ``SPAM_VALUABLE`` (UNIQUE по ``email_id``)."""
        row = await self._pool.fetchrow(
            SQL_INSERT_VALUABLE_SPAM,
            email_id,
            record.account_id,
            record.spam_tag,
            record.spam_url,
            record.summary or "",
            record.sender,
            record.subject,
            record.received_at,
        )
        return row is not None

    async def mark_email_deleted(self, email_id: int) -> None:
        """Помечает письмо удалённым в журнале ``emails``."""
        await self._pool.execute(SQL_MARK_EMAIL_DELETED, email_id)

    async def touch_account(self, account_id: int, *, error: str | None = None) -> None:
        """Пишет ``last_sync_at`` и текст последней ошибки (обрезан до 500 символов)."""
        message = (error or "").strip()[:500] or None
        await self._pool.execute(SQL_TOUCH_ACCOUNT, account_id, message)


def apply_ai_overrides(ai: AISettings, overrides: Mapping[str, Any]) -> AISettings:
    """Применяет ``ai_instructions`` к настройкам ИИ (модель, fallback, токены).

    ``max_tokens`` из БД не может превысить :data:`MAX_AI_TOKENS_CAP`: плохой
    конфиг не должен сжигать бюджет.
    """
    updates: dict[str, Any] = {}
    model = as_text(overrides.get("model"))
    if model:
        updates["classifier_model"] = normalize_model_name(model, ai.classifier_model)
    fallback = as_text(overrides.get("fallback_model"))
    if fallback:
        updates["fallback_model"] = normalize_model_name(fallback, ai.fallback_model)
    raw_tokens = overrides.get("max_tokens")
    tokens = 0
    if raw_tokens is not None:
        try:
            tokens = int(raw_tokens)
        except (TypeError, ValueError):
            tokens = 0
    if tokens >= 64:
        updates["max_tokens"] = min(tokens, MAX_AI_TOKENS_CAP)
    if not updates:
        return ai
    updates["instruction_source"] = "database"
    return replace(ai, **updates)


def apply_settings_overrides(settings: Settings, overrides: Mapping[str, Any]) -> Settings:
    """Возвращает копию :class:`Settings` с лимитами ИИ из БД."""
    if not overrides:
        return settings
    updated_ai = apply_ai_overrides(settings.ai, overrides)
    if updated_ai is settings.ai:
        return settings
    return replace(settings, ai=updated_ai)


def build_account_providers(
    accounts: Sequence[MailAccount],
    config_providers: Sequence[ProviderSettings],
    *,
    only_accounts: Sequence[str] = (),
) -> list[ProviderSettings]:
    """Превращает строки БД в провайдеров, наследуя white_list из конфига.

    Ищем провайдера по адресу/логину или по ``id``, чтобы белый список,
    заданный в ``workers.mail_worker.providers``, продолжал работать и для
    ящиков, пришедших из PostgreSQL.
    """
    by_login = {
        normalize_address(provider.username): provider
        for provider in config_providers
        if provider.username
    }
    by_id = {provider.id.lower(): provider for provider in config_providers}
    wanted = {str(item).strip().lower() for item in only_accounts if str(item).strip()}
    providers: list[ProviderSettings] = []
    for account in accounts:
        if wanted:
            candidates = {account.email.lower(), f"account-{account.id}"}
            if not candidates & wanted:
                continue
        fallback = by_login.get(account.email.lower()) or by_id.get(account.email.lower())
        providers.append(account.to_provider(fallback=fallback))
    return providers





def create_imap_client(provider: ProviderSettings) -> Any:
    """Создаёт IMAP-клиент ``aioimaplib`` с таймаутом на уровне протокола.

    :raises ConfigError: пакет ``aioimaplib`` не установлен.
    """
    try:
        from aioimaplib import aioimaplib
    except ImportError as exc:
        raise ConfigError(
            "aioimaplib is not installed: run 'uv pip install -r requirements.txt'"
        ) from exc
    if provider.use_ssl:
        return aioimaplib.IMAP4_SSL(
            host=provider.host, port=provider.port, timeout=provider.command_timeout_sec
        )
    return aioimaplib.IMAP4(
        host=provider.host, port=provider.port, timeout=provider.command_timeout_sec
    )


def _default_summarizer(limits: Limits) -> SummarizerFn:
    """Адаптер :func:`summarize_email_via_ai` к сигнатуре ``(client, ai, envelope, body)``."""

    async def summarize(client: Any, ai: AISettings, envelope: EmailEnvelope, body: str) -> str:
        return await summarize_email_via_ai(
            client,
            ai,
            envelope,
            body,
            body_chars=limits.body_chars,
            summary_chars=limits.summary_chars,
        )

    return summarize


class MailboxWorker:
    """Независимая asyncio-таска для одного почтового ящика.

    Один экземпляр обслуживает один провайдер: своя IMAP-сессия, свой интервал
    опроса, свой бюджет писем за цикл. Падение или зависание ящика не влияет на
    остальные, потому что в :func:`run_worker` каждый :class:`MailboxWorker`
    получает отдельную задачу ``asyncio.gather``.

    Зависимости (IMAP-фабрика, ИИ-клиент, notifier, классификатор, суммаризатор)
    внедряются через конструктор: это позволяет тестировать каскад офлайн, без
    сети и без ключей.
    """

    def __init__(
        self,
        settings: Settings,
        provider: ProviderSettings,
        *,
        ai_client: Any = None,
        notifier: Any = None,
        imap_factory: ImapFactory | None = None,
        classifier: ClassifierFn | None = None,
        summarizer: SummarizerFn | None = None,
        gateway: DatabaseGateway | None = None,
        once: bool = False,
        sleeper: SleeperFn = asyncio.sleep,
    ) -> None:
        self._settings = settings
        self._provider = provider
        self._ai_client = ai_client
        self._notifier = notifier
        self._imap_factory = imap_factory or create_imap_client
        self._classifier = classifier
        self._summarizer = summarizer or _default_summarizer(settings.limits)
        self._gateway = gateway
        self._once = once
        self._sleep = sleeper
        self._seen: set[str] = set()
        self._delivery_failures: dict[str, int] = {}
        self._dropped: set[str] = set()
        self._ai_warning_shown = False
        self._db_warning_shown = False
        self._connected = False

    # --- жизненный цикл сессии -------------------------------------------
    async def run(self) -> None:
        """Главный цикл: подключение → опросы → сон; при сбое - reconnect с backoff."""
        provider = self._provider
        delay = self._settings.reconnect.initial_delay_sec
        log(
            f"[{provider.id}] старт: {provider.host}:{provider.port} "
            f"ящик={provider.masked_account} mailbox={provider.mailbox} "
            f"интервал={provider.poll_interval_sec:g}с timeout={provider.command_timeout_sec:g}с"
        )
        while True:
            client: Any = None
            try:
                client = await self._open_session()
                delay = self._settings.reconnect.initial_delay_sec
                if self._once:
                    processed = await self.poll_once(client)
                    log(f"[{provider.id}] режим --once: обработано писем={processed}, выход")
                    return
                while True:
                    await self.poll_once(client)
                    await self._sleep(provider.poll_interval_sec)
            except asyncio.CancelledError:
                log(f"[{provider.id}] остановка: задача отменена")
                raise
            except ConfigError:
                raise
            except Exception as exc:  # любой сбой связи/IMAP - переподключаемся
                log(f"[{provider.id}] сбой сессии: {type(exc).__name__}: {exc}")
                if self._once:
                    log(f"[{provider.id}] режим --once: повтор не выполняется, выход с ошибкой")
                    raise
                log(f"[{provider.id}] переподключение через {delay:g}с")
                try:
                    await self._sleep(delay)
                except asyncio.CancelledError:
                    log(f"[{provider.id}] остановка во время ожидания reconnect")
                    raise
                delay = self._settings.reconnect.next_delay(delay)
            finally:
                await self._close_session(client)

    # --- режим --sync-folders --------------------------------------------
    async def folder_sync(self) -> int:
        """Синхронизирует папки ящика: ``LIST "" "*"`` → ``mail_folders``.

        Имена декодируются из modified UTF-7 (кириллица Mail.ru), сохранение
        идёт идемпотентным UPSERT. Требует подключения к БД и ``account_id``
        из ``mail_accounts`` - иначе сохранять папки некуда.

        :returns: число сохранённых папок.
        :raises ConfigError: режим запущен без PostgreSQL/``account_id``.
        :raises ImapSessionError: сбой IMAP-команды ``LIST``.
        """
        provider = self._provider
        if self._gateway is None or provider.account_id is None:
            raise ConfigError(
                f"[{provider.id}] --sync-folders requires PostgreSQL: "
                "set DATABASE_URL and use mail_accounts instead of --no-db"
            )
        client = await self._open_session()
        try:
            response = await self._command(client.list, '""', '"*"', label="list")
            lines = getattr(response, "lines", [])
            folders = [
                folder
                for folder in (parse_list_line(line) for line in lines)
                if folder is not None
            ]
            log(f"[{provider.id}] LIST: папок получено={len(folders)}")
            saved = await self._save_folders(folders)
            emit_event(provider.id, "folders_synced", folders=len(folders), saved=saved)
            return saved
        finally:
            await self._close_session(client)

    # --- слой БД (ошибки не должны ронять опрос ящика) --------------------
    def _account_id(self) -> int | None:
        """``id`` ящика из ``mail_accounts``; ``None`` в legacy-режиме."""
        if self._gateway is None:
            return None
        return self._provider.account_id

    async def _touch_account(self, *, error: str | None = None) -> None:
        """Пишет ``last_sync_at``/``last_error`` ящика (сбой только логируется)."""
        account_id = self._account_id()
        if account_id is None or self._gateway is None:
            return
        try:
            await self._gateway.touch_account(account_id, error=error)
        except Exception as exc:  # диагностика БД не должна ломать опрос
            log(
                f"[{self._provider.id}] БД: не удалось обновить статус ящика: "
                f"{type(exc).__name__}: {exc}"
            )

    async def _save_folders(self, folders: Sequence[FolderInfo]) -> int:
        """Сохраняет снимок папок в ``mail_folders`` (или только логирует)."""
        provider = self._provider
        account_id = self._account_id()
        if account_id is None or self._gateway is None:
            for folder in folders:
                log(f"[{provider.id}] папка: {folder.name} (delimiter={folder.delimiter!r})")
            log(f"[{provider.id}] БД не подключена: список папок не сохранён")
            return 0
        try:
            saved = await self._gateway.save_folders(account_id, folders)
        except Exception as exc:
            log(
                f"[{provider.id}] БД: не удалось сохранить папки: "
                f"{type(exc).__name__}: {exc}"
            )
            return 0
        await self._touch_account()
        log(f"[{provider.id}] mail_folders: сохранено папок={saved}")
        return saved


    async def _open_session(self) -> Any:
        """Открывает IMAP-сессию: greeting, login, select.

        Каждый шаг ограничен ``connect_timeout_sec`` / ``command_timeout_sec``:
        заблокированный или «молчащий» сервер не может подвесить воркер.

        :raises ImapSessionError: сервер отклонил логин или выбор ящика.
        :raises ImapCommandTimeout: шаг не уложился в жёсткий таймаут.
        """
        provider = self._provider
        client = self._imap_factory(provider)
        try:
            await self._wait(
                client.wait_hello_from_server(),
                provider.connect_timeout_sec,
                f"{provider.id}: приветствие сервера",
            )
            response = await self._wait(
                client.login(provider.username, provider.password),
                provider.connect_timeout_sec,
                f"{provider.id}: логин",
            )
            if as_text(getattr(response, "result", "")).upper() != "OK":
                raise ImapSessionError(
                    f"{provider.id}: login rejected for {provider.masked_account}"
                )
            response = await self._wait(
                client.select(provider.mailbox),
                provider.command_timeout_sec,
                f"{provider.id}: select {provider.mailbox}",
            )
            if as_text(getattr(response, "result", "")).upper() != "OK":
                raise ImapSessionError(
                    f"{provider.id}: cannot select mailbox {provider.mailbox!r}"
                )
        except BaseException:
            await self._close_session(client)
            raise
        self._connected = True
        log(f"[{provider.id}] подключено: ящик={provider.masked_account} mailbox={provider.mailbox}")
        return client

    async def _close_session(self, client: Any) -> None:
        """Аккуратно закрывает IMAP-сессию (ошибки только логируются)."""
        self._connected = False
        if client is None:
            return
        logout = getattr(client, "logout", None)
        if not callable(logout):
            return
        state_getter = getattr(client, "get_state", None)
        state = ""
        if callable(state_getter):
            try:
                state = as_text(state_getter())
            except Exception:  # состояние недоступно после обрыва - просто пробуем logout
                state = ""
        if state and state not in {"AUTH", "SELECTED"}:
            protocol = getattr(client, "protocol", None)
            transport = getattr(protocol, "transport", None)
            if transport is not None:
                try:
                    transport.close()
                except Exception as exc:  # транспорт мог закрыться сам
                    log(f"[{self._provider.id}] закрытие транспорта: {type(exc).__name__}: {exc}")
            pending = getattr(client, "_client_task", None)
            if pending is not None and not pending.done():
                pending.cancel()
            log(
                f"[{self._provider.id}] сессия не была авторизована (state={state}): "
                "соединение закрыто без LOGOUT"
            )
            return
        try:
            await asyncio.wait_for(logout(), timeout=self._provider.command_timeout_sec)
        except Exception as exc:  # обрыв уже закрытой сессии - не ошибка воркера
            log(f"[{self._provider.id}] закрытие сессии: {type(exc).__name__}: {exc}")

    async def _wait(self, awaitable: Awaitable[Any], timeout: float, label: str) -> Any:
        """Жёсткий таймаут для одной корутины IMAP.

        :raises ImapCommandTimeout: корутина не завершилась за ``timeout`` секунд.
        """
        try:
            if timeout and timeout > 0:
                return await asyncio.wait_for(awaitable, timeout=timeout)
            return await awaitable
        except asyncio.TimeoutError as exc:
            raise ImapCommandTimeout(f"{label}: timeout {timeout:g}s") from exc

    # --- опрос ящика ------------------------------------------------------
    async def poll_once(self, client: Any) -> int:
        """Один цикл опроса: ``SEARCH`` → обработка писем.

        Ошибка одного письма не рвёт сессию: она логируется, письмо остаётся
        непрочитанным и будет повторено в следующем цикле.

        :returns: число успешно обработанных писем.
        :raises ImapSessionError: сбой команды IMAP - вызывающий код переподключится.
        """
        provider = self._provider
        response = await self._command(client.search, *provider.search, label="search")
        numbers = parse_search_lines(getattr(response, "lines", []))
        if not numbers:
            log(f"[{provider.id}] новых писем нет")
            return 0

        budget = min(provider.max_messages, self._settings.limits.max_messages_per_poll)
        pending = numbers[:budget]
        log(f"[{provider.id}] непрочитанных={len(numbers)}, к обработке={len(pending)}")
        processed = 0
        for seq in pending:
            try:
                action = await self._handle_message(client, seq)
            except (ImapSessionError, asyncio.CancelledError):
                raise
            except Exception as exc:  # одно письмо не должно ронять весь ящик
                log(f"[{provider.id}] письмо #{seq}: ошибка {type(exc).__name__}: {exc}")
                action = "error"
            emit_event(provider.id, action, seq=seq)
            if action not in {"error", "ai_error", "ai_unavailable", "delivery_failed"}:
                processed += 1
        return processed

    async def _command(
        self,
        method: Callable[..., Awaitable[Any]],
        *args: Any,
        label: str,
    ) -> Any:
        """Вызывает IMAP-команду с жёстким таймаутом и проверкой ``result == OK``.

        :raises ImapCommandTimeout: команда не уложилась в ``command_timeout_sec``.
        :raises ImapSessionError: сервер вернул не ``OK``.
        """
        response = await self._wait(
            method(*args),
            self._provider.command_timeout_sec,
            f"{self._provider.id}: {label}",
        )
        result = as_text(getattr(response, "result", "")).upper()
        if result != "OK":
            raise ImapSessionError(f"{self._provider.id}: {label} failed (result={result or 'unknown'})")
        return response

    async def _fetch(self, client: Any, seq: str, part: str) -> bytes:
        """Возвращает литерал ответа ``FETCH`` для указанного письма и части."""
        response = await self._command(client.fetch, seq, part, label=f"fetch {seq} {part}")
        return parse_fetch_literal(getattr(response, "lines", []))

    async def _mark_seen(self, client: Any, seq: str, identifier: str) -> None:
        """Помечает письмо прочитанным и запоминает его в кэше сессии.

        Пометка ``\\Seen`` - единственный «журнал» воркера: после успешной
        обработки письмо больше не попадёт в ``SEARCH UNSEEN``. Если сервер
        отклонил ``STORE``, письмо останется в очереди - безопаснее обработать
        повторно, чем потерять.
        """
        self._seen.add(identifier)
        try:
            await self._command(client.store, seq, "+FLAGS", r"(\Seen)", label=f"store {seq} Seen")
        except ImapSessionError:
            raise
        except Exception as exc:
            log(f"[{self._provider.id}] не удалось пометить письмо #{seq} прочитанным: {exc}")

    # --- каскадная обработка одного письма --------------------------------
    async def _handle_message(self, client: Any, seq: str) -> str:
        """Обрабатывает одно письмо по каскаду и возвращает код действия."""
        provider = self._provider
        limits = self._settings.limits
        headers_raw = await self._fetch(client, seq, "(BODY.PEEK[HEADER])")
        envelope = build_envelope(headers_raw, seq)
        identifier = envelope.external_id

        if identifier in self._seen:
            log(f"[{provider.id}] письмо #{seq} уже обработано в этой сессии ({identifier})")
            await self._mark_seen(client, seq, identifier)
            return "duplicate"

        log(
            f"[{provider.id}] письмо #{seq} от {envelope.address or '?'} "
            f"тема={envelope.subject!r} дата={envelope.received_at}"
        )

        # Шаг 1: белый список - ИИ не вызывается вообще.
        if provider.is_whitelisted(envelope.address):
            body = await self._fetch_body(client, seq)
            whitelist = Classification(
                category=CATEGORY_WHITELIST,
                priority=PRIORITY_HIGH,
                reason="sender_in_white_list",
            )
            await self._persist_email(envelope, classification=whitelist, status="notified")
            payload = build_payload(
                provider=provider,
                envelope=envelope,
                action="whitelist",
                category=CATEGORY_WHITELIST,
                priority=PRIORITY_HIGH,
                reason="sender_in_white_list",
                text=truncate_text(body, limits.body_chars),
            )
            failed = await self._send_and_mark(client, seq, identifier, payload)
            if failed:
                return failed
            log(f"[{provider.id}] WHITELIST: алерт отправлен без ИИ (0 токенов)")
            return "whitelist"

        snippet = await self._fetch_snippet(client, seq, envelope)
        if self._ai_client is None:
            if not self._ai_warning_shown:
                log(
                    f"[{provider.id}] ИИ недоступен (ai.api_key не задан): "
                    "обрабатываются только письма из белого списка"
                )
                self._ai_warning_shown = True
            return "ai_unavailable"

        # Шаг 2: дешёвый классификатор.
        try:
            classification = await self._classify(envelope, snippet)
        except AiAnalysisError as exc:
            log(f"[{provider.id}] письмо #{seq}: ИИ не смог классифицировать: {exc}")
            return "ai_error"

        log(
            f"[{provider.id}] классификация: {classification.category}/{classification.priority} "
            f"({classification.reason})"
        )

        if classification.is_low:
            await self._persist_email(
                envelope,
                classification=classification,
                status="ignored",
                ai_model=self._settings.ai.classifier_model,
            )
            await self._mark_seen(client, seq, identifier)
            log(f"[{provider.id}] LOW: письмо проигнорировано, ядро не вызывается")
            return "ignored_low"

        # Шаг 2.1: полезный спам - выжимка в БД и пометка \\Deleted в ящике.
        if classification.is_valuable_spam:
            return await self._handle_valuable_spam(
                client, seq, identifier, envelope, classification, snippet
            )

        # Шаг 3: тяжёлый суммаризатор только для CRITICAL.
        if classification.is_critical:
            body = await self._fetch_body(client, seq)
            summary = ""
            try:
                summary = await self._summarize(envelope, body)
            except AiAnalysisError as exc:
                log(f"[{provider.id}] суммаризация не удалась ({exc}); отправляю тело письма")
            await self._persist_email(
                envelope,
                classification=classification,
                status="notified",
                ai_model=self._settings.ai.classifier_model,
            )
            payload = build_payload(
                provider=provider,
                envelope=envelope,
                action="critical",
                category=CATEGORY_CRITICAL,
                priority=PRIORITY_HIGH,
                reason=classification.reason or "classified_as_critical",
                text=summary or truncate_text(body, limits.body_chars),
                summary=summary or None,
            )
            failed = await self._send_and_mark(client, seq, identifier, payload)
            if failed:
                return failed
            log(f"[{provider.id}] CRITICAL: выжимка отправлена в ядро")
            return "critical"

        # VACANCY / SPAM с priority=HIGH: хватает превью.
        await self._persist_email(
            envelope,
            classification=classification,
            status="notified",
            ai_model=self._settings.ai.classifier_model,
        )
        payload = build_payload(
            provider=provider,
            envelope=envelope,
            action="classified",
            category=classification.category,
            priority=classification.priority,
            reason=classification.reason,
            text=truncate_text(snippet or envelope.subject, self._settings.ai.classify_chars),
            summary=classification.summary or None,
        )
        failed = await self._send_and_mark(client, seq, identifier, payload)
        if failed:
            return failed
        log(f"[{provider.id}] {classification.category}: уведомление отправлено")
        return "classified"

    async def _classify(self, envelope: EmailEnvelope, snippet: str) -> Classification:
        """Вызывает внедрённый или штатный классификатор."""
        if self._classifier is not None:
            return await self._classifier(self._ai_client, self._settings.ai, envelope, snippet)
        return await classify_email_via_ai(self._ai_client, self._settings.ai, envelope, snippet)

    async def _summarize(self, envelope: EmailEnvelope, body: str) -> str:
        """Вызывает внедрённый или штатный суммаризатор."""
        return await self._summarizer(self._ai_client, self._settings.ai, envelope, body)

    async def _persist_email(
        self,
        envelope: EmailEnvelope,
        *,
        classification: Classification | None,
        status: str,
        is_deleted: bool = False,
        ai_model: str | None = None,
    ) -> int | None:
        """UPSERT письма в ``emails``; сбой БД не прерывает обработку ящика."""
        account_id = self._account_id()
        if account_id is None or self._gateway is None:
            if not self._db_warning_shown:
                log(
                    f"[{self._provider.id}] БД не подключена: журнал emails "
                    "и valuable_spam недоступны"
                )
                self._db_warning_shown = True
            return None
        record = build_email_record(
            account_id,
            envelope,
            classification=classification,
            status=status,
            is_deleted=is_deleted,
            ai_model=ai_model,
        )
        try:
            return await self._gateway.upsert_email(record)
        except Exception as exc:  # БД не должна блокировать почту
            log(
                f"[{self._provider.id}] БД: ошибка записи письма "
                f"{envelope.external_id}: {type(exc).__name__}: {exc}"
            )
            return None

    async def _handle_valuable_spam(
        self,
        client: Any,
        seq: str,
        identifier: str,
        envelope: EmailEnvelope,
        classification: Classification,
        snippet: str,
    ) -> str:
        """``SPAM_VALUABLE``: выжимка -> ``valuable_spam`` -> ``\\Deleted`` в ящике.

        Удаление выполняется только после успешной записи в БД: если БД
        недоступна, письмо остаётся в ящике, а в ядро уходит уведомление с
        пометкой ``db_unavailable``.
        """
        provider = self._provider
        limits = self._settings.limits
        account_id = self._account_id()
        email_id = await self._persist_email(
            envelope,
            classification=classification,
            status="classified",
            ai_model=self._settings.ai.classifier_model,
        )
        stored = False
        if email_id is not None and account_id is not None and self._gateway is not None:
            record = build_email_record(
                account_id,
                envelope,
                classification=classification,
                status="deleted",
                is_deleted=True,
                ai_model=self._settings.ai.classifier_model,
            )
            try:
                stored = await self._gateway.save_valuable_spam(email_id, record)
            except Exception as exc:
                log(
                    f"[{provider.id}] БД: valuable_spam не сохранён: "
                    f"{type(exc).__name__}: {exc}"
                )
        if stored:
            await self._mark_deleted(client, seq, identifier)
            if email_id is not None and self._gateway is not None:
                try:
                    await self._gateway.mark_email_deleted(email_id)
                except Exception as exc:
                    log(f"[{provider.id}] БД: отметка об удалении не сохранена: {exc}")
            log(
                f"[{provider.id}] SPAM_VALUABLE: тег={classification.spam_tag!r} "
                f"url={classification.spam_url!r}; письмо помечено на удаление"
            )
        else:
            log(
                f"[{provider.id}] SPAM_VALUABLE: БД недоступна, "
                "письмо оставлено в ящике (удаление отменено)"
            )

        payload = build_payload(
            provider=provider,
            envelope=envelope,
            action="spam_valuable",
            category=classification.category,
            priority=classification.priority,
            reason=classification.reason or "valuable_spam",
            text=truncate_text(
                classification.summary or snippet or envelope.subject, limits.body_chars
            ),
            summary=classification.summary or None,
            spam_tag=classification.spam_tag,
            spam_url=classification.spam_url,
        )
        if not stored:
            payload["db_unavailable"] = True
        failed = await self._send_and_mark(client, seq, identifier, payload)
        if failed:
            return failed
        return "spam_valuable"

    async def _mark_deleted(self, client: Any, seq: str, identifier: str) -> None:
        """Помечает письмо ``\\Deleted`` (без EXPUNGE, см. architecture.md §12)."""
        try:
            await self._command(
                client.store, seq, "+FLAGS", r"(\Deleted)", label=f"store {seq} Deleted"
            )
        except ImapSessionError:
            raise
        except Exception as exc:
            log(f"[{self._provider.id}] не удалось пометить письмо #{seq} на удаление: {exc}")


    async def _send_and_mark(
        self,
        client: Any,
        seq: str,
        identifier: str,
        payload: Mapping[str, Any],
    ) -> str | None:
        """Отправляет уведомление и при успехе помечает письмо прочитанным.

        :returns: ``None`` при успехе, иначе код действия (``delivery_failed`` /
            ``delivery_dropped``) для лога и события.
        """
        if await self._deliver(payload, identifier):
            await self._mark_seen(client, seq, identifier)
            return None
        if identifier in self._dropped:
            # Лимит попыток исчерпан: помечаем прочитанным, чтобы не зациклиться.
            await self._mark_seen(client, seq, identifier)
            return "delivery_dropped"
        return "delivery_failed"

    async def _deliver(self, payload: Mapping[str, Any], identifier: str) -> bool:
        """Отправляет уведомление в ядро с учётом лимита попыток на одно письмо."""
        if self._notifier is None:
            log(f"[{self._provider.id}] notifier не настроен: уведомление не отправлено")
            return False
        try:
            delivered = bool(await self._notifier.send(payload))
        except Exception as exc:  # ошибка доставки не должна ронять опрос
            log(f"[{self._provider.id}] ошибка отправки в ядро: {type(exc).__name__}: {exc}")
            delivered = False
        if delivered:
            self._delivery_failures.pop(identifier, None)
            return True

        attempts = self._delivery_failures.get(identifier, 0) + 1
        limit = self._settings.limits.max_delivery_attempts
        self._delivery_failures[identifier] = attempts
        log(
            f"[{self._provider.id}] доставка в ядро не удалась "
            f"(попытка {attempts}/{limit} для {identifier})"
        )
        if attempts >= limit:
            log(
                f"[{self._provider.id}] лимит попыток исчерпан: письмо {identifier} "
                "будет помечено прочитанным, чтобы не блокировать ящик"
            )
            self._delivery_failures.pop(identifier, None)
            self._dropped.add(identifier)
        return False

    async def _fetch_body(self, client: Any, seq: str) -> str:
        """Скачивает полное письмо и извлекает из него читаемый текст."""
        raw = await self._fetch(client, seq, "(BODY.PEEK[])")
        body = extract_body_text(raw)
        if not body:
            log(f"[{self._provider.id}] письмо #{seq}: тело пустое или не содержит text/*")
        return body

    async def _fetch_snippet(self, client: Any, seq: str, envelope: EmailEnvelope) -> str:
        """Скачивает только первые ``snippet_bytes`` байт тела (экономия токенов).

        Для multipart-писем ``BODY[TEXT]`` начинается со служебной границы,
        поэтому при пустом превью дополнительно запрашивается первая текстовая
        часть ``BODY[1]``. Если текста нет совсем, превью строится из темы.
        """
        size = self._settings.limits.snippet_bytes
        raw = await self._fetch(client, seq, f"(BODY.PEEK[TEXT]<0.{size}>)")
        text = decode_partial(
            raw,
            charset=envelope.charset,
            transfer_encoding=envelope.transfer_encoding,
        )
        if not text:
            raw = await self._fetch(client, seq, f"(BODY.PEEK[1]<0.{size}>)")
            text = decode_partial(raw, charset=envelope.charset)
        if not text:
            log(f"[{self._provider.id}] письмо #{seq}: превью пустое, использую тему")
            text = envelope.subject
        return truncate_text(text, self._settings.ai.classify_chars, suffix="")

async def run_worker(
    settings: Settings,
    providers: Sequence[ProviderSettings],
    *,
    once: bool = False,
    gateway: DatabaseGateway | None = None,
) -> int:
    """Запускает по отдельной asyncio-таске на каждый ящик.

    Таски создаются сразу и ждут друг друга через :func:`asyncio.gather`, поэтому
    ящики опрашиваются конкурентно: медленный или заблокированный сервер не
    задерживает остальные. Внутри :meth:`MailboxWorker.run` уже есть reconnect,
    так что падение одного ящика не приводит к остановке сервиса.

    :param gateway: слой PostgreSQL; ``None`` - legacy-режим без журнала.
    """
    ai_client: Any = None
    if settings.ai.ready:
        ai_client = create_ai_client(settings.ai)
        log(
            "ИИ: каскад готов "
            f"(classifier={settings.ai.classifier_model}, summarizer={settings.ai.summarizer_model}, "
            f"fallback={settings.ai.fallback_model}, timeout={settings.ai.timeout_sec:g}с, "
            f"retry={settings.ai.retry_attempts}, max_tokens={settings.ai.max_tokens}, "
            f"источник={settings.ai.instruction_source})"
        )
    else:
        log("ИИ: ai.api_key не задан - классификация отключена, работают только письма из white_list")

    notifier = CoreNotifier(settings.core)
    log(f"ЯДРО: уведомления пойдут на {settings.core.masked_endpoint}")
    tasks = [
        asyncio.create_task(
            MailboxWorker(
                settings,
                provider,
                ai_client=ai_client,
                notifier=notifier,
                gateway=gateway,
                once=once,
            ).run(),
            name=f"mailbox-{provider.id}",
        )
        for provider in providers
    ]
    log(f"СТАРТ: ящиков в работе={len(tasks)} ({', '.join(provider.id for provider in providers)})")
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await notifier.close()
        await close_ai_client(ai_client)
    log("ОСТАНОВКА: сессии закрыты, ресурсы освобождены")
    return EXIT_OK


async def run_folder_sync(
    settings: Settings,
    providers: Sequence[ProviderSettings],
    *,
    gateway: DatabaseGateway | None = None,
) -> int:
    """Режим ``--sync-folders``: ``LIST`` по каждому ящику → ``mail_folders``.

    Ящики обрабатываются последовательно: список папок небольшой, а
    последовательный режим не создаёт лишнюю нагрузку на IMAP-сервер. Ошибка
    одного ящика логируется и не мешает остальным.

    :raises ConfigError: PostgreSQL не подключён - сохранять папки некуда.
    """
    if gateway is None:
        raise ConfigError("--sync-folders requires PostgreSQL (DATABASE_URL)")
    saved_total = 0
    failures = 0
    for provider in providers:
        worker = MailboxWorker(settings, provider, gateway=gateway, once=True)
        try:
            saved_total += await worker.folder_sync()
        except ConfigError:
            raise
        except Exception as exc:  # сбой одного ящика не останавливает остальные
            failures += 1
            message = f"{type(exc).__name__}: {exc}"
            log(f"[{provider.id}] синхронизация папок не удалась: {message}")
            if provider.account_id is not None:
                try:
                    await gateway.touch_account(provider.account_id, error=message)
                except Exception as db_exc:
                    log(f"[{provider.id}] БД: статус ошибки не сохранён: {db_exc}")
    log(
        f"SYNC-FOLDERS: ящиков={len(providers)}, папок сохранено={saved_total}, "
        f"ошибок={failures}"
    )
    return EXIT_OK


def describe_settings(settings: Settings, providers: Sequence[ProviderSettings]) -> dict[str, Any]:
    """Готовит безопасное описание конфигурации для ``--dry-run`` (без секретов)."""
    limits = settings.limits
    return {
        "config": str(settings.config_path),
        "ai": {
            "base_url": settings.ai.base_url,
            "api_key": "set" if settings.ai.ready else "missing",
            "classifier_model": settings.ai.classifier_model,
            "summarizer_model": settings.ai.summarizer_model,
            "fallback_model": settings.ai.fallback_model,
            "classify_chars": settings.ai.classify_chars,
            "json_mode": settings.ai.json_mode,
            "timeout_sec": settings.ai.timeout_sec,
            "retry_attempts": settings.ai.retry_attempts,
            "retry_base_delay_sec": settings.ai.retry_base_delay_sec,
            "max_tokens": settings.ai.max_tokens,
            "instruction_source": settings.ai.instruction_source,
        },
        "database": {
            "enabled": settings.database.ready,
            "dsn": "set" if settings.database.ready else "missing",
            "dsn_env": settings.database.dsn_env,
            "endpoint": settings.database.masked_dsn,
            "pool": f"{settings.database.min_size}-{settings.database.max_size}",
            "migrations": settings.database.migrations_path,
        },
        "core": {
            "endpoint": settings.core.masked_endpoint,
            "timeout_sec": settings.core.timeout_sec,
            "retries": settings.core.retries,
        },
        "limits": {
            "max_messages_per_poll": limits.max_messages_per_poll,
            "snippet_bytes": limits.snippet_bytes,
            "body_chars": limits.body_chars,
            "summary_chars": limits.summary_chars,
            "max_delivery_attempts": limits.max_delivery_attempts,
        },
        "reconnect": {
            "initial_delay_sec": settings.reconnect.initial_delay_sec,
            "max_delay_sec": settings.reconnect.max_delay_sec,
            "backoff_factor": settings.reconnect.backoff_factor,
        },
        "providers": [
            {
                "id": provider.id,
                "account_id": provider.account_id,
                "label": provider.label,
                "host": provider.host,
                "port": provider.port,
                "ssl": provider.use_ssl,
                "account": provider.masked_account,
                "credentials": "set" if provider.has_credentials else "missing",
                "mailbox": provider.mailbox,
                "search": list(provider.search),
                "poll_interval_sec": provider.poll_interval_sec,
                "connect_timeout_sec": provider.connect_timeout_sec,
                "command_timeout_sec": provider.command_timeout_sec,
                "max_messages_per_poll": provider.max_messages,
                "white_list": sorted(provider.white_list),
                "white_list_domains": sorted(provider.white_list_domains),
            }
            for provider in providers
        ],
    }

def build_parser() -> argparse.ArgumentParser:
    """Аргументы CLI: конфиг, выбор ящиков, режимы опроса и синхронизации папок."""
    parser = argparse.ArgumentParser(
        prog="mail_worker.py",
        description="Async IMAP mail worker on PostgreSQL + token-saving AI cascade (DeepSeek).",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"path to config (default: {DEFAULT_CONFIG})",
    )
    parser.add_argument(
        "--provider",
        action="append",
        default=[],
        metavar="ID",
        help="process only the given mailbox id from workers.mail_worker.providers (repeatable)",
    )
    parser.add_argument(
        "--account",
        action="append",
        default=[],
        metavar="EMAIL",
        help="limit PostgreSQL accounts by email (repeatable, default: all active)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="run a single poll cycle per mailbox and exit (debug/cron mode)",
    )
    parser.add_argument(
        "--sync-folders",
        action="store_true",
        help="read IMAP LIST for every mailbox and upsert mail_folders, then exit",
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        help="ignore PostgreSQL and use workers.mail_worker.providers (legacy mode)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print resolved settings without any network call",
    )
    return parser


def run(args: argparse.Namespace) -> int:
    """Выполняет запуск воркера и возвращает код выхода."""
    loaded = load_env_file()
    if loaded:
        log(f"ENV: .env загружен (переменных: {loaded})")
    settings = load_settings(args.config, only_providers=args.provider)

    if not settings.enabled:
        log("mail_worker выключен в конфиге (enabled=false) - выходим")
        emit_event("all", "skipped", reason="worker_disabled")
        return EXIT_OK

    if args.dry_run:
        providers = [
            provider
            for provider in settings.providers
            if provider.enabled and provider.has_credentials
        ]
        description = describe_settings(settings, providers)
        description["source"] = (
            "database" if settings.database.ready and not args.no_db else "config"
        )
        emit({"worker": "mail_worker", "worker_id": WORKER_ID, "status": "dry_run", **description})
        log(
            f"DRY-RUN: источник ящиков={description['source']}, "
            f"конфиг-ящиков к работе={len(providers)} из {len(settings.providers)}, "
            f"ИИ={'готов' if settings.ai.ready else 'выключен'}, "
            f"PostgreSQL={'настроен' if settings.database.ready else 'не настроен'}, "
            f"ядро={settings.core.masked_endpoint}"
        )
        if settings.database.ready:
            log(
                f"DRY-RUN: DSN={settings.database.masked_dsn} "
                f"(env={settings.database.dsn_env}), миграция={settings.database.migrations_path}"
            )
        else:
            log(f"DRY-RUN: {settings.database.dsn_env} не задан - режим только по конфигу")
        for provider in providers:
            log(
                f"DRY-RUN [{provider.id}] {provider.host}:{provider.port} "
                f"ящик={provider.masked_account} white_list={len(provider.white_list)} адресов, "
                f"доменов={len(provider.white_list_domains)}"
            )
        return EXIT_OK

    if args.sync_folders and (args.no_db or not settings.database.ready):
        raise ConfigError(
            "--sync-folders requires PostgreSQL: set DATABASE_URL in .env "
            "and drop --no-db"
        )

    log(f"КОНФИГ: {settings.config_path}")
    try:
        return asyncio.run(run_service(settings, args))
    except KeyboardInterrupt:
        log("остановка по Ctrl+C: воркер завершён штатно")
        return EXIT_OK
    except asyncio.CancelledError:
        log("остановка: задачи отменены")
        return EXIT_OK
    except ConfigError:
        raise
    except Exception as exc:  # фатальная ошибка вне цикла reconnect
        log(f"ФАТАЛЬНАЯ ОШИБКА: {type(exc).__name__}: {exc}")
        return EXIT_RUNTIME_ERROR


async def run_service(settings: Settings, args: argparse.Namespace) -> int:
    """Готовит пул PostgreSQL, выбирает ящики и запускает нужный режим.

    Аккаунты берутся из ``mail_accounts`` (RLS отдаёт только ``is_active``);
    ``--no-db`` или недоступная БД переводят воркер в legacy-режим с ящиками
    из ``workers.mail_worker.providers``.
    """
    gateway: DatabaseGateway | None = None
    pool: Any = None
    try:
        if settings.database.ready and not args.no_db:
            try:
                pool = await create_database_pool(settings.database)
                gateway = AsyncpgGateway(pool)
                log(
                    f"БД: подключено к {settings.database.masked_dsn} "
                    f"(пул {settings.database.min_size}-{settings.database.max_size}, "
                    f"timeout {settings.database.command_timeout_sec:g}с)"
                )
                overrides = await gateway.fetch_ai_overrides()
                settings = apply_settings_overrides(settings, overrides)
                if overrides:
                    log(f"БД: лимиты ИИ из ai_instructions: {sorted(overrides)}")
            except Exception as exc:
                await close_database_pool(pool)
                pool = None
                gateway = None
                if args.sync_folders:
                    raise
                log(
                    f"БД: недоступна ({type(exc).__name__}: {exc}); "
                    "работаем без журнала PostgreSQL"
                )

        providers = await resolve_providers(settings, args, gateway)

        if args.sync_folders:
            if gateway is None:
                raise ConfigError("--sync-folders requires PostgreSQL (DATABASE_URL)")
            return await run_folder_sync(settings, providers, gateway=gateway)
        return await run_worker(settings, providers, once=args.once, gateway=gateway)
    finally:
        await close_database_pool(pool)


async def resolve_providers(
    settings: Settings,
    args: argparse.Namespace,
    gateway: DatabaseGateway | None,
) -> list[ProviderSettings]:
    """Определяет список ящиков: ``mail_accounts`` (RLS) или конфиг.

    Пароли проверяются по окружению: ящик без ``ENV_*``-переменной пропускается
    с предупреждением, остальные продолжают работу.

    :raises ConfigError: ни одного ящика с учётными данными не осталось.
    """
    accounts: list[MailAccount] = []
    if gateway is not None:
        try:
            accounts = await gateway.fetch_active_accounts()
        except Exception as exc:
            log(f"БД: не удалось прочитать mail_accounts: {type(exc).__name__}: {exc}")
            accounts = []

    if accounts:
        providers = build_account_providers(
            accounts, settings.providers, only_accounts=args.account
        )
        log(
            f"БД: активных ящиков={len(accounts)} (RLS is_active), к работе={len(providers)}"
        )
        for account in accounts:
            if not account.has_credentials:
                log(
                    f"[{account.email}] пропуск: {account.env_password_key} "
                    "не задан в окружении"
                )
        providers = [p for p in providers if p.enabled and p.has_credentials]
        if not providers:
            raise ConfigError(
                "no active mailbox with credentials in mail_accounts: "
                "check is_active and ENV_* variables"
            )
        return providers

    if gateway is not None:
        log("БД: активных ящиков нет - переключаюсь на workers.mail_worker.providers")
    for provider in settings.providers:
        if not provider.enabled:
            log(f"[{provider.id}] провайдер выключен (enabled=false) - пропуск")
        elif not provider.has_credentials:
            log(
                f"[{provider.id}] пропуск: логин или пароль не найдены в окружении "
                f"(проверьте {provider.id}: username/password в конфиге)"
            )
    providers = [
        provider
        for provider in settings.providers
        if provider.enabled and provider.has_credentials
    ]
    if not providers:
        raise ConfigError(
            "no enabled mailbox with credentials: export the ENV_* variables from "
            "workers.mail_worker.providers or fill mail_accounts"
        )
    return providers


def main(argv: Sequence[str] | None = None) -> int:
    """Точка входа CLI."""
    configure_stdio()
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except ConfigError as exc:
        emit(
            {
                "worker": "mail_worker",
                "worker_id": WORKER_ID,
                "status": "failed",
                "reason": "config_error",
                "error": str(exc),
            }
        )
        log(f"ОШИБКА КОНФИГУРАЦИИ: {exc}")
        return EXIT_CONFIG_ERROR


if __name__ == "__main__":
    sys.exit(main())
















