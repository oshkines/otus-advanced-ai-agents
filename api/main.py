"""Backend API (FastAPI) AI Dev Navigator: REST-слой над PostgreSQL + AI-фича.

Назначение: дать фронтенду Next.js (`web/`) один контракт на все данные дашборда —
агрегаты Bento-карточек, CRUD по доменным сущностям и AI-классификацию.

Документ-контракт: ``docs/api_spec.md`` (Pydantic-модели, HTTP-коды, каскад LLM).
Исполняемая спецификация: ``tests/test_api_tdd.py`` (TDD: тесты написаны до реализации).

Слои:

* **Настройки** — :class:`ApiSettings` читает ``.env`` (``override=False``: переменные
  Windows имеют приоритет). Секреты в логи не попадают, DSN маскируется.
* **Шлюз БД** — :class:`AsyncpgGateway` поверх пула ``asyncpg`` (роль
  ``navigator_worker`` + RLS, least privilege). Ошибки драйвера превращаются в
  :class:`DatabaseUnavailable` → HTTP 503 ``db_unavailable``.
* **AI-каскад** — :func:`classify_with_cascade`: строгий Pydantic Structured Output,
  таймаут 15 с на запрос, 3 попытки на модель, резервная модель после основных.
  Бюджет токенов берётся из ``ai_instructions`` (кап 1024).
* **Маршруты** — :func:`create_app`: CORS для ``http://localhost:3000`` и IP стенда,
  единый конверт ошибок ``{"detail": {"code", "message"}}``.

Особенности хранения (у роли API нет прав DDL, см. ``docs/api_spec.md`` §2.4):

* ``vacancies.is_ignored`` / ``vacancies.work_format`` — в ``raw -> 'api'``;
* ``mail_folders.scan_mode`` — токен ``NAV_SCAN:<mode>`` в массиве ``flags``.

Удаление вакансии — мягкое скрытие (``is_ignored = TRUE``): RLS-политика
``vacancies_worker_active`` запрещает ``status = 'archived'``, а роль без ``DELETE``.

Запуск (Windows 11, PowerShell, из корня проекта):

    .\\.venv\\Scripts\\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000

Swagger UI: ``http://127.0.0.1:8000/docs``, OpenAPI: ``/openapi.json``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import locale
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Mapping, Protocol, Sequence
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi import status as http_status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    computed_field,
    field_validator,
    model_validator,
)

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
ENV_PATH: Path = PROJECT_ROOT / ".env"

API_PREFIX: str = "/api/v1"
API_VERSION: str = "1.0.0"
APP_PORT: int = 8000

# Порты фронтенда: локальная разработка + рабочий стенд из README.
DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://82.148.236.43:3000",
)

# Контроль стоимости и устойчивости LLM (требование ДЗ: 15 с / 3 попытки / fallback).
DEFAULT_AI_TIMEOUT_SEC: float = 15.0
DEFAULT_AI_RETRY_ATTEMPTS: int = 3
DEFAULT_AI_RETRY_BASE_DELAY_SEC: float = 1.5
MAX_AI_RETRY_DELAY_SEC: float = 8.0
DEFAULT_AI_MAX_TOKENS: int = 400
MAX_AI_TOKENS_CAP: int = 1024
MAX_AI_INPUT_CHARS: int = 6000
MAX_AI_RESPONSE_CHARS: int = 4000
MAX_CLASSIFICATION_SUMMARY_CHARS: int = 600
MAX_SPAM_TAG_CHARS: int = 64
MAX_SPAM_URL_CHARS: int = 2048

# API-метаданные в существующих «расширяемых» колонках (см. §2.4 спецификации).
SCAN_FLAG_PREFIX: str = "NAV_SCAN:"
SCAN_MODES: tuple[str, ...] = ("full", "headers", "skip")
IGNORED_SQL: str = (
    "COALESCE(({alias}.raw -> 'api' ->> 'is_ignored') IN ('true','t','1','yes'), FALSE)"
)
WORK_FORMAT_SQL: str = "NULLIF(lower({alias}.raw -> 'api' ->> 'work_format'), '')"

DEFAULT_CLASSIFIER_PROMPT: str = (
    "Classify the incoming email into WHITELIST | CRITICAL | VACANCY | SPAM_VALUABLE | SPAM."
)
JSON_CONTRACT: str = (
    'Ответь ТОЛЬКО JSON-объектом без markdown: {"category": "...", "summary": "...", '
    '"spam_tag": null, "spam_url": null, "work_format": null}. '
    "category строго из WHITELIST, CRITICAL, VACANCY, SPAM_VALUABLE, SPAM; "
    "summary - 1-2 предложения по-русски; spam_tag - короткий тег или null; "
    "spam_url - только http(s)-ссылка или null; work_format - remote|hybrid|office "
    "или null (заполняется только для вакансий)."
)
RETRY_INSTRUCTION: str = (
    "Предыдущий ответ нарушил контракт. Верни ТОЛЬКО JSON-объект с полями "
    "category, summary, spam_tag, spam_url, work_format (см. системный промпт)."
)

PRIORITY_BY_CATEGORY: Mapping[str, str] = {
    "WHITELIST": "HIGH",
    "CRITICAL": "HIGH",
    "VACANCY": "HIGH",
    "SPAM_VALUABLE": "HIGH",
    "SPAM": "LOW",
}

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


# ---------------------------------------------------------------------------
# Ошибки уровня приложения → HTTP-коды (единый конверт {"detail": {...}}).
# ---------------------------------------------------------------------------
class ApiError(RuntimeError):
    """Базовая ошибка прикладного слоя."""


class DatabaseUnavailable(ApiError):
    """PostgreSQL недоступна или у роли нет прав → HTTP 503."""


class LlmUnavailable(ApiError):
    """Ни основная, ни резервная модель не ответили → HTTP 502."""


class ClassificationError(ApiError):
    """Ответ модели не является JSON по схеме ``AiClassification`` (повод для retry)."""


def _error_payload(code: str, message: str) -> dict[str, Any]:
    """Единый конверт ошибки для доменных отказов."""
    return {"detail": {"code": code, "message": message}}


def not_found(entity: str, entity_id: Any) -> HTTPException:
    """HTTP 404 с кодом ``not_found``."""
    return HTTPException(
        status_code=http_status.HTTP_404_NOT_FOUND,
        detail={"code": "not_found", "message": f"{entity} id={entity_id} не найден"},
    )


def mask_dsn(dsn: str) -> str:
    """Строка подключения без пароля — безопасна для логов и ответов ``/health``."""
    if not dsn:
        return ""
    parts = urlsplit(dsn)
    if not parts.hostname:
        return "***"
    port = f":{parts.port}" if parts.port else ""
    database = (parts.path or "").lstrip("/")
    return f"{parts.hostname}{port}/{database}" if database else f"{parts.hostname}{port}"


def load_env_file(path: Path, *, override: bool = False) -> int:
    """Загружает ``.env`` через ``python-dotenv`` (fallback — ручной разбор).

    ``override=False``: значения из окружения Windows всегда приоритетнее файла.
    """
    if not path.exists():
        return 0
    try:
        from dotenv import load_dotenv  # noqa: PLC0415 - опциональная зависимость
    except ImportError:
        return _load_env_file_fallback(path, override=override)
    return 1 if load_dotenv(dotenv_path=path, override=override) else 0


def _load_env_file_fallback(path: Path, *, override: bool) -> int:
    """Минимальный парсер ``KEY=VALUE`` на случай отсутствия ``python-dotenv``."""
    loaded = 0
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key or (key in os.environ and not override):
            continue
        os.environ[key] = value
        loaded += 1
    return loaded


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    """Читает целое из окружения в заданных границах (мусор → default)."""
    try:
        value = int(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def _env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    """Читает float из окружения (мусор → default), не ниже ``minimum``."""
    try:
        value = float(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


def _env_bool(name: str, default: bool) -> bool:
    """Читает bool из окружения: ``1/true/yes/on`` → True."""
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _cors_origins() -> tuple[str, ...]:
    """Дефолтные origin'ы фронтенда + список из ``API_CORS_ORIGINS`` (через запятую)."""
    origins = list(DEFAULT_CORS_ORIGINS)
    for chunk in str(os.environ.get("API_CORS_ORIGINS", "")).split(","):
        origin = chunk.strip().rstrip("/")
        if origin and origin not in origins:
            origins.append(origin)
    return tuple(origins)


# ---------------------------------------------------------------------------
# Настройки приложения (единственный источник — окружение/``.env``).
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ApiSettings:
    """Параметры API: провайдер LLM, лимиты стоимости, БД и CORS."""

    provider: Literal["deepseek", "openrouter"] = "deepseek"
    base_url: str = "https://api.deepseek.com"
    api_key: str = field(default="", repr=False)
    model: str = "deepseek-chat"
    fallback_model: str = "deepseek-reasoner"
    max_tokens: int = DEFAULT_AI_MAX_TOKENS
    temperature: float = 0.1
    timeout_sec: float = DEFAULT_AI_TIMEOUT_SEC
    retry_attempts: int = DEFAULT_AI_RETRY_ATTEMPTS
    retry_base_delay_sec: float = DEFAULT_AI_RETRY_BASE_DELAY_SEC
    json_mode: bool = True
    database_url: str = field(default="", repr=False)
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS
    version: str = API_VERSION

    @property
    def ready(self) -> bool:
        """``True``, если API-ключ LLM найден в окружении."""
        return bool(self.api_key)

    @property
    def masked_dsn(self) -> str:
        """DSN без пароля — для ``/health`` и логов."""
        return mask_dsn(self.database_url)

    @classmethod
    def from_env(cls, *, load_env: bool = True, **overrides: Any) -> "ApiSettings":
        """Собирает настройки из ``.env``/окружения; ``overrides`` — для тестов."""
        if load_env:
            load_env_file(ENV_PATH)
        provider = str(os.environ.get("LLM_PROVIDER", "deepseek")).strip().lower()
        if provider not in {"deepseek", "openrouter"}:
            provider = "deepseek"
        if provider == "openrouter":
            base_default = "https://openrouter.ai/api/v1"
            key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get(
                "ENV_OPENROUTER_API_KEY", ""
            )
            model_default = "deepseek/deepseek-chat"
            fallback_default = "deepseek/deepseek-reasoner"
        else:
            base_default = "https://api.deepseek.com"
            key = os.environ.get("ENV_DEEPSEEK_API_KEY") or os.environ.get(
                "DEEPSEEK_API_KEY", ""
            )
            model_default = "deepseek-chat"
            fallback_default = "deepseek-reasoner"
        values: dict[str, Any] = {
            "provider": provider,
            "base_url": str(os.environ.get("LLM_BASE_URL", "") or base_default).rstrip("/"),
            "api_key": key.strip(),
            "model": str(os.environ.get("LLM_MODEL", "") or model_default),
            "fallback_model": str(
                os.environ.get("LLM_FALLBACK_MODEL", "") or fallback_default
            ),
            "max_tokens": _env_int(
                "AI_MAX_TOKENS",
                DEFAULT_AI_MAX_TOKENS,
                minimum=64,
                maximum=MAX_AI_TOKENS_CAP,
            ),
            "temperature": _env_float("AI_TEMPERATURE", 0.1),
            "timeout_sec": _env_float("AI_TIMEOUT_SEC", DEFAULT_AI_TIMEOUT_SEC, minimum=1.0),
            "retry_attempts": _env_int(
                "AI_RETRY_ATTEMPTS", DEFAULT_AI_RETRY_ATTEMPTS, minimum=1, maximum=5
            ),
            "retry_base_delay_sec": _env_float(
                "AI_RETRY_BASE_DELAY_SEC", DEFAULT_AI_RETRY_BASE_DELAY_SEC, minimum=0.0
            ),
            "json_mode": _env_bool("AI_JSON_MODE", True),
            "database_url": str(os.environ.get("DATABASE_URL", "")).strip(),
            "cors_origins": _cors_origins(),
            "version": API_VERSION,
        }
        values.update({key_: value for key_, value in overrides.items() if value is not None})
        return cls(**values)


# ---------------------------------------------------------------------------
# Pydantic-схемы: системные ручки и Bento-дашборд (docs/api_spec.md §3.1-3.2).
# ---------------------------------------------------------------------------
class DatabaseHealth(BaseModel):
    """Здоровье PostgreSQL: пинг, размер пула, маскированный DSN."""

    status: Literal["ok", "unavailable"]
    latency_ms: int | None = None
    pool_size: int | None = None
    pool_free: int | None = None
    target: str | None = None


class AiProviderHealth(BaseModel):
    """Готовность LLM-провайдера (ключ, base_url, модели)."""

    provider: Literal["deepseek", "openrouter"]
    base_url: str
    ready: bool
    model: str
    fallback_model: str


class HealthResponse(BaseModel):
    """``GET /health``: сервис жив всегда, БД может быть недоступна (``degraded``)."""

    status: Literal["ok", "degraded"]
    version: str
    generated_at: datetime
    database: DatabaseHealth
    ai: AiProviderHealth


class TagCount(BaseModel):
    """Частота тега полезного спама (для облака тегов)."""

    tag: str
    count: int


class MailSummary(BaseModel):
    """Агрегаты канала Email."""

    accounts: int
    folders_synced: int
    folders_watched: int
    folders_skipped: int
    emails_total: int
    emails_new: int
    emails_classified: int
    last_sync_at: datetime | None


class ValuableSpamItem(BaseModel):
    """Одна выжимка полезного спама."""

    id: int
    spam_tag: str | None
    spam_url: str | None
    summary: str
    sender: str
    subject: str
    received_at: datetime


class ValuableSpamSummary(BaseModel):
    """Сводка ``valuable_spam``: счётчики, топ тегов, последние выжимки."""

    total: int
    last_7_days: int
    top_tags: list[TagCount]
    latest: list[ValuableSpamItem]


class VacancySummary(BaseModel):
    """Сводка вакансий с разбивкой по формату работы."""

    total: int
    active: int
    ignored: int
    by_work_format: dict[str, int]
    last_published_at: datetime | None


class RzhdSummary(BaseModel):
    """Сводка билетов РЖД."""

    total: int
    watching: int
    available: int
    booked: int
    nearest_travel_date: date | None
    cheapest_price_rub: float | None


class AiSummary(BaseModel):
    """Действующие лимиты ИИ из ``ai_instructions``."""

    classifier_model: str | None
    fallback_model: str | None
    max_tokens: int | None
    instructions_active: int


class DashboardSummary(BaseModel):
    """Один ответ на все Bento-карточки дашборда."""

    generated_at: datetime
    database: DatabaseHealth
    mail: MailSummary
    valuable_spam: ValuableSpamSummary
    vacancies: VacancySummary
    rzhd: RzhdSummary
    ai: AiSummary


# ---------------------------------------------------------------------------
# Общие валидаторы и словари-литералы.
# ---------------------------------------------------------------------------
ScanMode = Literal["full", "headers", "skip"]
WorkFormat = Literal["remote", "hybrid", "office"]
VacancyStatus = Literal["new", "viewed", "applied", "rejected"]
CarType = Literal["coupe", "platzkart", "sv", "sitting", "luxury"]
TicketStatus = Literal["watching", "available", "booked", "expired", "cancelled"]
Category = Literal["WHITELIST", "CRITICAL", "VACANCY", "SPAM_VALUABLE", "SPAM"]
Priority = Literal["HIGH", "LOW"]
EmailStatus = Literal["new", "classified", "notified", "ignored", "deleted", "error"]
Kind = Literal["email", "vacancy"]


def _validate_http_url(value: str | None) -> str | None:
    """Пропускает только абсолютные http(s)-ссылки (никаких ``javascript:``)."""
    text = (value or "").strip()
    if not text:
        return None
    parts = urlsplit(text)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        raise ValueError("url должен быть абсолютной http(s)-ссылкой")
    return text[:MAX_SPAM_URL_CHARS]


def _require_any_field(payload: BaseModel, names: Sequence[str]) -> None:
    """PATCH-модель без единого поля бессмысленна — отдаём 422."""
    if not any(getattr(payload, name) is not None for name in names):
        raise ValueError(f"нужно хотя бы одно поле из {list(names)}")


def _hash_external_id(*parts: str) -> str:
    """Детерминированный ``external_id`` для записей, созданных из API."""
    digest = hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()
    return f"api-{digest[:24]}"


def derive_scan_mode(flags: Sequence[str], is_selectable: bool) -> str:
    """Вычисляет ``scan_mode`` папки из токена ``NAV_SCAN:*`` в IMAP-флагах."""
    for flag in flags or ():
        if isinstance(flag, str) and flag.upper().startswith(SCAN_FLAG_PREFIX):
            mode = flag.split(":", 1)[1].strip().lower()
            if mode in SCAN_MODES:
                return mode
    return "full" if is_selectable else "skip"


def _with_scan_flag(flags: Sequence[str], scan_mode: str) -> list[str]:
    """Заменяет API-токен ``NAV_SCAN:*``, сохраняя IMAP-флаги без изменений."""
    kept = [
        flag
        for flag in flags or ()
        if not (isinstance(flag, str) and flag.upper().startswith(SCAN_FLAG_PREFIX))
    ]
    kept.append(f"{SCAN_FLAG_PREFIX}{scan_mode}")
    return kept


# ---------------------------------------------------------------------------
# Почтовые папки (docs/api_spec.md §3.3).
# ---------------------------------------------------------------------------
class MailFolder(BaseModel):
    """Папка IMAP + выбранный режим сканирования."""

    id: int
    account_id: int
    name: str
    raw_name: str | None = None
    special_use: str | None = None
    is_selectable: bool
    scan_mode: ScanMode
    unread_count: int
    message_count: int
    last_synced_at: datetime


class MailFolderPatch(BaseModel):
    """PATCH папки: режим сканирования и/или выбор папки."""

    model_config = ConfigDict(extra="forbid")

    is_selectable: bool | None = None
    scan_mode: ScanMode | None = None

    @model_validator(mode="after")
    def _require_change(self) -> "MailFolderPatch":
        """Пустое тело — ошибка клиента, а не «ничего не делать»."""
        _require_any_field(self, ("is_selectable", "scan_mode"))
        return self


class MailFolderList(BaseModel):
    """Список папок с общим количеством (без пагинации: их десятки)."""

    items: list[MailFolder]
    total: int


class FolderSyncResult(BaseModel):
    """Итог ``POST /mail/sync-folders``: коды, счётчики и размер снимка папок."""

    status: Literal["ok", "partial", "error"]
    exit_code: int
    folders_saved: int | None = None
    failures: int = 0
    folders_total: int
    duration_ms: int
    detail: str | None = None


# ---------------------------------------------------------------------------
# Лента писем (таблица ``emails`` + имя папки из ``mail_folders``).
# ---------------------------------------------------------------------------
class EmailItem(BaseModel):
    """Письмо из журнала ``emails``: тема, отправитель, вердикт ИИ и метаданные."""

    id: int
    account_id: int
    folder_id: int | None = None
    folder_name: str | None = None
    message_id: str | None = None
    external_id: str
    sender: str
    sender_name: str
    subject: str
    received_at: datetime
    category: Category | None = None
    priority: Priority | None = None
    ai_summary: str | None = None
    spam_tag: str | None = None
    spam_url: str | None = None
    status: EmailStatus
    is_seen: bool
    is_deleted: bool
    ai_model: str | None = None
    error_text: str | None = None
    processed_at: datetime | None = None
    created_at: datetime


class EmailList(BaseModel):
    """``GET /emails``: свежие письма сверху (``created_at DESC``)."""

    items: list[EmailItem]
    total: int
    limit: int


# ---------------------------------------------------------------------------
# Вакансии (docs/api_spec.md §3.4).
# ---------------------------------------------------------------------------
class Vacancy(BaseModel):
    """Вакансия сканера + UI-атрибуты ``work_format`` / ``is_ignored``."""

    id: int
    source: str
    external_id: str
    title: str
    company: str
    stack: list[str]
    tags: list[str]
    salary_min: float | None = None
    salary_max: float | None = None
    currency: str
    url: str | None = None
    published_at: datetime | None = None
    status: VacancyStatus
    score: int | None = None
    work_format: WorkFormat | None = None
    is_ignored: bool
    created_at: datetime
    updated_at: datetime


class VacancyCreate(BaseModel):
    """POST вакансии (идемпотентный UPSERT по ``source`` + ``external_id``)."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1, max_length=64)
    external_id: str | None = Field(default=None, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    company: str = Field(default="", max_length=300)
    stack: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    salary_min: float | None = Field(default=None, ge=0)
    salary_max: float | None = Field(default=None, ge=0)
    currency: str = Field(default="RUB", max_length=8)
    url: str | None = None
    published_at: datetime | None = None
    status: VacancyStatus = "new"
    score: int | None = Field(default=None, ge=0, le=100)
    work_format: WorkFormat | None = None
    is_ignored: bool = False
    description: str | None = Field(default=None, max_length=20000)

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Только http(s)-ссылки."""
        return _validate_http_url(value)

    @model_validator(mode="after")
    def _check_salary(self) -> "VacancyCreate":
        """Вилка должна быть монотонной (та же CHECK-логика, что в БД)."""
        if (
            self.salary_min is not None
            and self.salary_max is not None
            and self.salary_max < self.salary_min
        ):
            raise ValueError("salary_max не может быть меньше salary_min")
        return self

    def to_record(self) -> dict[str, Any]:
        """Поля строки ``vacancies``; UI-атрибуты уходят в ``raw.api``."""
        external_id = self.external_id or _hash_external_id(
            self.source, self.title, self.url or "", self.company
        )
        return {
            "source": self.source,
            "external_id": external_id,
            "title": self.title,
            "company": self.company,
            "stack": list(self.stack),
            "tags": list(self.tags),
            "salary_min": self.salary_min,
            "salary_max": self.salary_max,
            "currency": self.currency,
            "url": self.url,
            "published_at": self.published_at,
            "status": self.status,
            "score": self.score,
            "work_format": self.work_format,
            "is_ignored": self.is_ignored,
            "description": self.description,
        }


class VacancyPatch(BaseModel):
    """PATCH вакансии: статус, игнор по формату работы, оценка, ссылка."""

    model_config = ConfigDict(extra="forbid")

    status: VacancyStatus | None = None
    is_ignored: bool | None = None
    work_format: WorkFormat | None = None
    score: int | None = Field(default=None, ge=0, le=100)
    url: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    company: str | None = Field(default=None, max_length=300)

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Только http(s)-ссылки."""
        return _validate_http_url(value)

    @model_validator(mode="after")
    def _require_change(self) -> "VacancyPatch":
        """Пустой PATCH отклоняем (422), чтобы не гонять пустой UPDATE."""
        _require_any_field(
            self, ("status", "is_ignored", "work_format", "score", "url", "title", "company")
        )
        return self

    def to_changes(self) -> dict[str, Any]:
        """Только переданные поля: ``None`` = «не менять»."""
        return {
            key: getattr(self, key)
            for key in ("status", "is_ignored", "work_format", "score", "url", "title", "company")
            if getattr(self, key) is not None
        }


class VacancyList(BaseModel):
    """Страница вакансий."""

    items: list[Vacancy]
    total: int
    limit: int
    offset: int


# ---------------------------------------------------------------------------
# Билеты РЖД (docs/api_spec.md §3.5).
# ---------------------------------------------------------------------------
class RzhdTicket(BaseModel):
    """Наблюдаемый рейс РЖД: места, цена, статус."""

    id: int
    direction_from: str
    direction_to: str
    travel_date: date
    train_number: str
    car_type: CarType
    seats_available: int
    price_rub: float | None = None
    booking_url: str | None = None
    status: TicketStatus
    passenger_name: str | None = None
    trip_window_start: date | None = None
    trip_window_end: date | None = None
    notified_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class RzhdTicketCreate(BaseModel):
    """POST билета (UPSERT по параметрам предложения)."""

    model_config = ConfigDict(extra="forbid")

    direction_from: str = Field(min_length=1, max_length=120)
    direction_to: str = Field(min_length=1, max_length=120)
    travel_date: date
    train_number: str = Field(default="", max_length=32)
    car_type: CarType
    seats_available: int = Field(default=0, ge=0)
    price_rub: float | None = Field(default=None, ge=0)
    booking_url: str | None = None
    status: TicketStatus = "watching"
    passenger_name: str | None = Field(default=None, max_length=120)
    trip_window_start: date | None = None
    trip_window_end: date | None = None
    raw: dict[str, Any] | None = None

    @field_validator("booking_url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Только http(s)-ссылки на покупку."""
        return _validate_http_url(value)

    @model_validator(mode="after")
    def _check_window(self) -> "RzhdTicketCreate":
        """Окно каникул: конец не раньше начала (CHECK в БД повторяем на входе)."""
        if (
            self.trip_window_start is not None
            and self.trip_window_end is not None
            and self.trip_window_end < self.trip_window_start
        ):
            raise ValueError("trip_window_end не может быть раньше trip_window_start")
        return self

    def to_record(self) -> dict[str, Any]:
        """Поля строки ``rzhd_tickets`` (ровно то, что ждёт SQL)."""
        return {
            "direction_from": self.direction_from,
            "direction_to": self.direction_to,
            "travel_date": self.travel_date,
            "train_number": self.train_number,
            "car_type": self.car_type,
            "seats_available": self.seats_available,
            "price_rub": self.price_rub,
            "booking_url": self.booking_url,
            "status": self.status,
            "passenger_name": self.passenger_name,
            "trip_window_start": self.trip_window_start,
            "trip_window_end": self.trip_window_end,
            "raw": self.raw,
        }


class RzhdTicketList(BaseModel):
    """Страница билетов."""

    items: list[RzhdTicket]
    total: int


# ---------------------------------------------------------------------------
# AI-классификация: строгий Structured Output (docs/api_spec.md §3.6, §5).
# ---------------------------------------------------------------------------
def normalize_whitespace(text: str) -> str:
    """Схлопывает пробелы/переводы строк: модель любит форматировать «красиво»."""
    return re.sub(r"\s+", " ", text or "").strip()


class AiClassification(BaseModel):
    """Ответ модели по контракту: 5 полей, приоритет вычисляется детерминированно."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    category: Category
    summary: str = Field(default="", description="1-2 предложения по-русски")
    spam_tag: str | None = Field(default=None, description="promo, sale, coupon")
    spam_url: str | None = Field(default=None, description="http(s)-ссылка из письма")
    work_format: WorkFormat | None = Field(default=None, description="только для вакансий")

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
        """``null`` → ``""``, пробелы схлопываются, длина ограничена."""
        return normalize_whitespace("" if value is None else str(value))[
            :MAX_CLASSIFICATION_SUMMARY_CHARS
        ]

    @field_validator("spam_tag")
    @classmethod
    def _clamp_tag(cls, value: str | None) -> str | None:
        """Короткий тег или ``None``."""
        text = normalize_whitespace(value or "")[:MAX_SPAM_TAG_CHARS]
        return text or None

    @field_validator("spam_url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Ссылка с чужой схемой (``javascript:``) отбрасывается, а не роняет ответ."""
        text = (value or "").strip()
        if not text:
            return None
        parts = urlsplit(text)
        if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
            return None
        return text[:MAX_SPAM_URL_CHARS]

    @field_validator("work_format", mode="before")
    @classmethod
    def _check_work_format(cls, value: Any) -> Any:
        """Неизвестный формат работы не должен ломать вакансию — приводим к ``None``."""
        if value is None:
            return None
        text = normalize_whitespace(str(value)).lower()
        if text in {"remote", "hybrid", "office"}:
            return text
        return None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def priority(self) -> Literal["HIGH", "LOW"]:
        """Приоритет из категории: модель не решает, звать ли инженера."""
        return "LOW" if self.category == "SPAM" else "HIGH"


class ClassifyPreviewRequest(BaseModel):
    """Вход AI-фичи: письмо (``kind=email``) или описание вакансии."""

    model_config = ConfigDict(extra="forbid")

    kind: Kind = "email"
    text: str = Field(min_length=1, max_length=20000)
    subject: str = Field(default="", max_length=400)
    sender: str = Field(default="", max_length=400)
    sender_name: str = Field(default="", max_length=200)
    vacancy_title: str = Field(default="", max_length=300)
    company: str = Field(default="", max_length=300)
    url: str | None = None
    stack: list[str] = Field(default_factory=list)
    salary_min: float | None = Field(default=None, ge=0)
    salary_max: float | None = Field(default=None, ge=0)
    account_id: int | None = Field(default=None, ge=1)
    external_id: str | None = Field(default=None, max_length=128)
    received_at: datetime | None = None
    persist: bool = True

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Только http(s)-ссылки."""
        return _validate_http_url(value)

    @model_validator(mode="after")
    def _check_kind(self) -> "ClassifyPreviewRequest":
        """Для вакансии нужен заголовок: без него нечего сохранять в ``vacancies``."""
        if self.kind == "vacancy" and not (self.vacancy_title.strip() or self.subject.strip()):
            raise ValueError("для kind='vacancy' нужен vacancy_title (или subject)")
        return self


class AiRun(BaseModel):
    """Технический отчёт о вызове LLM (модель, попытки, бюджет, задержка)."""

    provider: Literal["deepseek", "openrouter"]
    model: str
    used_model: str
    fallback_model: str
    fallback_used: bool
    attempts: int
    max_tokens: int
    temperature: float
    timeout_sec: float
    latency_ms: int
    json_mode: bool


class PersistedRecords(BaseModel):
    """Идентификаторы сохранённых строк (``None`` — запись не создавалась)."""

    email_id: int | None = None
    valuable_spam_id: int | None = None
    vacancy_id: int | None = None


class ClassifyPreviewResponse(BaseModel):
    """Ответ AI-фичи: вердикт модели, отчёт о вызове, ссылки на записи в БД."""

    kind: Kind
    classification: AiClassification
    ai: AiRun
    persisted: PersistedRecords


def parse_classification(raw: str) -> AiClassification:
    """Разбирает ответ модели по строгой схеме :class:`AiClassification`.

    Markdown-обёртка и словесный шум вокруг JSON отбрасываются, но сам JSON обязан
    содержать ``category`` из контракта. Любое нарушение — :class:`ClassificationError`
    (повод для повтора, а не для 500).

    :raises ClassificationError: JSON отсутствует, битый или нарушает схему.
    """
    text = (raw or "").strip()
    if not text:
        raise ClassificationError("empty model response")
    text = _FENCE_RE.sub("", text).strip()
    match = _JSON_OBJECT_RE.search(text)
    if match is None:
        raise ClassificationError(f"no JSON object in response: {text[:120]!r}")
    try:
        payload: Any = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ClassificationError(f"invalid JSON: {exc.msg}") from exc
    if not isinstance(payload, Mapping):
        raise ClassificationError("JSON root is not an object")
    try:
        return AiClassification.model_validate(dict(payload))
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        raise ClassificationError(
            f"schema violation at {first.get('loc')}: {first.get('msg')}"
        ) from exc


# ---------------------------------------------------------------------------
# SQL: выборки и UPSERT'ы (RLS-роль navigator_worker, схема 001/002).
# ---------------------------------------------------------------------------
def _vacancy_columns(alias: str = "v") -> str:
    """Колонки вакансии + вычисленные UI-атрибуты из ``raw -> 'api'``."""
    work_format = WORK_FORMAT_SQL.format(alias=alias)
    return (
        f"{alias}.id, {alias}.source, {alias}.external_id, {alias}.title, {alias}.company, "
        f"{alias}.stack, {alias}.tags, {alias}.salary_min, {alias}.salary_max, "
        f"{alias}.currency, {alias}.url, {alias}.published_at, {alias}.status, {alias}.score, "
        f"{alias}.created_at, {alias}.updated_at, "
        f"CASE WHEN {work_format} IN ('remote', 'hybrid', 'office') THEN {work_format} END "
        f"AS work_format, "
        f"{IGNORED_SQL.format(alias=alias)} AS is_ignored"
    )


SQL_PING: str = "SELECT 1"

SQL_DASHBOARD_MAIL: str = """
SELECT
    (SELECT count(*) FROM mail_accounts) AS accounts,
    (SELECT count(*) FROM mail_folders) AS folders_synced,
    (SELECT count(*) FROM mail_folders WHERE is_selectable) AS folders_watched,
    (SELECT count(*) FROM mail_folders
      WHERE EXISTS (SELECT 1 FROM unnest(flags) AS flag
                    WHERE upper(flag) = 'NAV_SCAN:SKIP')) AS folders_skipped,
    (SELECT count(*) FROM emails) AS emails_total,
    (SELECT count(*) FROM emails WHERE status = 'new') AS emails_new,
    (SELECT count(*) FROM emails WHERE status = 'classified') AS emails_classified,
    (SELECT max(last_sync_at) FROM mail_accounts) AS last_sync_at
"""

SQL_DASHBOARD_SPAM_TOTALS: str = """
SELECT count(*) AS total,
       count(*) FILTER (WHERE created_at >= now() - INTERVAL '7 days') AS last_7_days
FROM valuable_spam
"""

SQL_DASHBOARD_SPAM_TAGS: str = """
SELECT spam_tag AS tag, count(*) AS count
FROM valuable_spam
WHERE spam_tag IS NOT NULL
GROUP BY spam_tag
ORDER BY count DESC, tag
LIMIT 5
"""

SQL_DASHBOARD_SPAM_LATEST: str = """
SELECT id, spam_tag, spam_url, summary, sender, subject, received_at
FROM valuable_spam
ORDER BY created_at DESC, id DESC
LIMIT 3
"""

SQL_DASHBOARD_VACANCIES: str = """
SELECT
    count(*) AS total,
    count(*) FILTER (
        WHERE status IN ('new', 'viewed')
          AND NOT COALESCE((raw -> 'api' ->> 'is_ignored') IN ('true','t','1','yes'), FALSE)
    ) AS active,
    count(*) FILTER (
        WHERE COALESCE((raw -> 'api' ->> 'is_ignored') IN ('true','t','1','yes'), FALSE)
    ) AS ignored,
    count(*) FILTER (WHERE lower(raw -> 'api' ->> 'work_format') = 'remote') AS remote,
    count(*) FILTER (WHERE lower(raw -> 'api' ->> 'work_format') = 'hybrid') AS hybrid,
    count(*) FILTER (WHERE lower(raw -> 'api' ->> 'work_format') = 'office') AS office,
    count(*) FILTER (
        WHERE COALESCE(lower(raw -> 'api' ->> 'work_format'), '') NOT IN
              ('remote', 'hybrid', 'office')
    ) AS unknown_count,
    max(published_at) AS last_published_at
FROM vacancies
"""

SQL_DASHBOARD_RZHD: str = """
SELECT
    count(*) AS total,
    count(*) FILTER (WHERE status = 'watching') AS watching,
    count(*) FILTER (WHERE status = 'available' OR (seats_available > 0 AND status <> 'cancelled'))
        AS available,
    count(*) FILTER (WHERE status = 'booked') AS booked,
    min(travel_date) FILTER (WHERE travel_date >= CURRENT_DATE) AS nearest_travel_date,
    min(price_rub) FILTER (WHERE seats_available > 0) AS cheapest_price_rub
FROM rzhd_tickets
"""

SQL_DASHBOARD_AI: str = """
SELECT
    (SELECT count(*) FROM ai_instructions) AS instructions_active,
    (SELECT model FROM ai_instructions
      WHERE scope = 'global' AND scope_key = 'classifier' LIMIT 1) AS classifier_model,
    (SELECT fallback_model FROM ai_instructions
      WHERE scope = 'global' AND scope_key = 'classifier' LIMIT 1) AS fallback_model,
    (SELECT max_tokens FROM ai_instructions
      WHERE scope = 'global' AND scope_key = 'classifier' LIMIT 1) AS max_tokens
"""

SQL_FOLDER_SELECT: str = """
SELECT id, account_id, name, raw_name, special_use, is_selectable, flags,
       unread_count, message_count, last_synced_at
FROM mail_folders
"""

SQL_FOLDER_LOCK: str = """
SELECT id, account_id, name, raw_name, special_use, is_selectable, flags,
       unread_count, message_count, last_synced_at
FROM mail_folders
WHERE id = $1
FOR UPDATE
"""

SQL_FOLDER_UPDATE: str = """
UPDATE mail_folders
SET flags = $2, is_selectable = $3
WHERE id = $1
RETURNING id, account_id, name, raw_name, special_use, is_selectable, flags,
          unread_count, message_count, last_synced_at
"""

SQL_EMAIL_SELECT: str = """
SELECT e.id, e.account_id, e.folder_id, e.message_id, e.external_id,
       e.sender, e.sender_name, e.subject, e.received_at,
       e.category, e.priority, e.summary AS ai_summary,
       e.spam_tag, e.spam_url, e.status, e.is_seen, e.is_deleted,
       e.ai_model, e.error_text, e.processed_at, e.created_at,
       f.name AS folder_name
FROM emails e
LEFT JOIN mail_folders f ON f.id = e.folder_id
"""

SQL_VACANCY_INSERT: str = """
INSERT INTO vacancies (
    source, external_id, title, company, stack, tags, salary_min, salary_max,
    currency, url, published_at, status, score, raw
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        jsonb_build_object('api', $14::jsonb))
ON CONFLICT (source, external_id) DO NOTHING
RETURNING id
"""

SQL_VACANCY_UPDATE_BY_KEY: str = """
UPDATE vacancies
SET title = $3, company = $4, stack = $5, tags = $6, salary_min = $7,
    salary_max = $8, currency = $9, url = $10, published_at = $11, status = $12,
    score = $13, raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{api}',
                                 COALESCE(raw -> 'api', '{}'::jsonb) || $14::jsonb, TRUE)
WHERE source = $1 AND external_id = $2
RETURNING id
"""

SQL_VACANCY_BY_ID: str = "SELECT {columns} FROM vacancies v WHERE v.id = $1"

SQL_VACANCY_PATCH: str = """
UPDATE vacancies AS v
SET status = COALESCE($2, v.status),
    score = COALESCE($3, v.score),
    url = COALESCE($4, v.url),
    title = COALESCE($5, v.title),
    company = COALESCE($6, v.company),
    raw = jsonb_set(COALESCE(v.raw, '{{}}'::jsonb), '{{api}}',
                    COALESCE(v.raw -> 'api', '{{}}'::jsonb) || $7::jsonb, TRUE)
WHERE v.id = $1
RETURNING {columns}
"""

SQL_TICKET_INSERT: str = """
INSERT INTO rzhd_tickets (
    direction_from, direction_to, travel_date, train_number, car_type,
    seats_available, price_rub, booking_url, status, passenger_name,
    trip_window_start, trip_window_end, raw
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
ON CONFLICT (direction_from, direction_to, travel_date, train_number, car_type)
DO NOTHING
RETURNING id
"""

SQL_TICKET_UPDATE_BY_KEY: str = """
UPDATE rzhd_tickets
SET seats_available = $6, price_rub = $7, booking_url = $8, status = $9,
    passenger_name = $10, trip_window_start = $11, trip_window_end = $12,
    raw = COALESCE($13::jsonb, rzhd_tickets.raw)
WHERE direction_from = $1 AND direction_to = $2 AND travel_date = $3
  AND train_number = $4 AND car_type = $5
RETURNING id
"""

SQL_TICKET_BY_ID: str = """
SELECT id, direction_from, direction_to, travel_date, train_number, car_type,
       seats_available, price_rub, booking_url, status, passenger_name,
       trip_window_start, trip_window_end, notified_at, created_at, updated_at
FROM rzhd_tickets
WHERE id = $1
"""

SQL_TICKET_SELECT: str = """
SELECT id, direction_from, direction_to, travel_date, train_number, car_type,
       seats_available, price_rub, booking_url, status, passenger_name,
       trip_window_start, trip_window_end, notified_at, created_at, updated_at
FROM rzhd_tickets
"""

SQL_AI_INSTRUCTION: str = """
SELECT model, fallback_model, max_tokens, temperature
FROM ai_instructions
WHERE scope = 'global' AND scope_key = $1
ORDER BY priority
LIMIT 1
"""

SQL_FIRST_ACTIVE_ACCOUNT: str = "SELECT id FROM mail_accounts ORDER BY id LIMIT 1"

SQL_ACCOUNT_BY_ID: str = "SELECT id FROM mail_accounts WHERE id = $1"

SQL_EMAIL_UPSERT: str = """
INSERT INTO emails (
    account_id, external_id, sender, sender_name, subject, received_at,
    category, priority, summary, spam_tag, spam_url, status, ai_model,
    is_deleted, processed_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
ON CONFLICT (account_id, external_id) DO UPDATE
SET category = EXCLUDED.category,
    priority = EXCLUDED.priority,
    summary = EXCLUDED.summary,
    spam_tag = EXCLUDED.spam_tag,
    spam_url = EXCLUDED.spam_url,
    status = EXCLUDED.status,
    ai_model = EXCLUDED.ai_model,
    is_deleted = EXCLUDED.is_deleted,
    processed_at = now()
RETURNING id
"""

SQL_VALUABLE_SPAM_UPSERT: str = """
INSERT INTO valuable_spam (
    email_id, account_id, spam_tag, spam_url, summary, sender, subject, received_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (email_id) DO UPDATE
SET spam_tag = EXCLUDED.spam_tag,
    spam_url = EXCLUDED.spam_url,
    summary = EXCLUDED.summary,
    sender = EXCLUDED.sender,
    subject = EXCLUDED.subject,
    received_at = EXCLUDED.received_at
RETURNING id
"""

SQL_AI_VACANCY_INSERT: str = """
INSERT INTO vacancies (
    source, external_id, title, company, stack, tags, salary_min, salary_max,
    currency, url, published_at, status, score, raw
)
VALUES ($1, $2, $3, $4, $5, '{}', $6, $7, 'RUB', $8, now(), 'new', $9,
        jsonb_build_object('api', $10::jsonb))
ON CONFLICT (source, external_id) DO UPDATE
SET title = EXCLUDED.title,
    company = EXCLUDED.company,
    stack = EXCLUDED.stack,
    salary_min = EXCLUDED.salary_min,
    salary_max = EXCLUDED.salary_max,
    url = EXCLUDED.url,
    score = EXCLUDED.score,
    raw = jsonb_set(COALESCE(vacancies.raw, '{}'::jsonb), '{api}',
                    COALESCE(vacancies.raw -> 'api', '{}'::jsonb) || EXCLUDED.raw -> 'api', TRUE)
RETURNING id
"""


# ---------------------------------------------------------------------------
# Шлюз БД: контракт (тесты подставляют фейк с теми же методами).
# ---------------------------------------------------------------------------
class DatabaseGateway(Protocol):
    """Что API умеет у БД. Реализация — :class:`AsyncpgGateway`."""

    async def ping(self) -> float:
        """Возвращает задержку ``SELECT 1`` в миллисекундах."""

    async def pool_stats(self) -> tuple[int, int]:
        """Размер пула и число свободных соединений."""

    async def fetch_dashboard(self) -> Mapping[str, Any]:
        """Агрегаты Bento-карточек одним пакетом запросов."""

    async def list_folders(
        self,
        *,
        account_id: int | None = None,
        scan_mode: str | None = None,
        is_selectable: bool | None = None,
    ) -> list[Mapping[str, Any]]:
        """Снимок папок с вычисленным ``scan_mode``."""

    async def update_folder(
        self,
        folder_id: int,
        *,
        is_selectable: bool | None,
        scan_mode: str | None,
    ) -> Mapping[str, Any] | None:
        """Меняет режим сканирования и/или выбор папки; ``None`` — папки нет."""

    async def list_emails(
        self,
        *,
        limit: int,
        category: str | None = None,
        folder_id: int | None = None,
        status: str | None = None,
    ) -> list[Mapping[str, Any]]:
        """Лента писем (``created_at DESC``) с именем папки из JOIN."""

    async def list_vacancies(
        self,
        *,
        status: str | None = None,
        work_format: str | None = None,
        is_ignored: bool | None = None,
        query: str | None = None,
        limit: int,
        offset: int,
    ) -> tuple[list[Mapping[str, Any]], int]:
        """Страница вакансий и общее количество по фильтру."""

    async def create_vacancy(
        self, record: Mapping[str, Any]
    ) -> tuple[Mapping[str, Any], bool]:
        """UPSERT вакансии; второй элемент — «создана ли новая строка»."""

    async def update_vacancy(
        self, vacancy_id: int, changes: Mapping[str, Any]
    ) -> Mapping[str, Any] | None:
        """Частичное обновление вакансии; ``None`` — вакансии нет."""

    async def hide_vacancy(self, vacancy_id: int) -> Mapping[str, Any] | None:
        """Мягкое скрытие (``is_ignored = TRUE``) вместо DELETE."""

    async def list_tickets(
        self,
        *,
        status: str | None = None,
        car_type: str | None = None,
        direction_from: str | None = None,
        direction_to: str | None = None,
        travel_date_from: date | None = None,
        travel_date_to: date | None = None,
        only_available: bool | None = None,
        limit: int,
        offset: int,
    ) -> tuple[list[Mapping[str, Any]], int]:
        """Страница билетов и общее количество по фильтру."""

    async def create_ticket(
        self, record: Mapping[str, Any]
    ) -> tuple[Mapping[str, Any], bool]:
        """UPSERT рейса РЖД; второй элемент — «создан ли новый рейс»."""

    async def fetch_ai_instruction(self, scope_key: str) -> Mapping[str, Any] | None:
        """Лимиты и промпт из ``ai_instructions`` (RLS отдаёт только активные)."""

    async def resolve_account_id(self, account_id: int | None) -> int | None:
        """Проверяет ящик или берёт первый активный (``None`` — ящиков нет)."""

    async def save_email_classification(self, **fields: Any) -> int:
        """UPSERT письма с вердиктом модели; возвращает ``emails.id``."""

    async def upsert_valuable_spam(self, **fields: Any) -> int:
        """UPSERT выжимки полезного спама; возвращает ``valuable_spam.id``."""

    async def insert_ai_vacancy(self, **fields: Any) -> int:
        """Сохраняет вакансию, размеченную моделью; возвращает ``vacancies.id``."""


# ---------------------------------------------------------------------------
# Реализация шлюза поверх пула asyncpg.
# ---------------------------------------------------------------------------
def _folder_row_to_dict(row: Mapping[str, Any]) -> dict[str, Any]:
    """Строка ``mail_folders`` → ответ API (``scan_mode`` вычисляется из ``flags``)."""
    data = dict(row)
    flags = list(data.pop("flags", None) or [])
    data["scan_mode"] = derive_scan_mode(flags, bool(data.get("is_selectable")))
    return data


class AsyncpgGateway:
    """Реализация :class:`DatabaseGateway` поверх пула ``asyncpg``."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    @contextlib.asynccontextmanager
    async def _translated(self) -> AsyncIterator[None]:
        """Переводит любые ошибки драйвера/RLS в :class:`DatabaseUnavailable`."""
        try:
            yield
        except DatabaseUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - сеть, SQL, права, таймауты
            raise DatabaseUnavailable(f"PostgreSQL: {type(exc).__name__}: {exc}") from exc

    # -- системные ---------------------------------------------------------
    async def ping(self) -> float:
        """``SELECT 1`` с замером задержки (мс)."""
        started = time.perf_counter()
        async with self._translated():
            await self._pool.fetchval(SQL_PING)
        return (time.perf_counter() - started) * 1000.0

    async def pool_stats(self) -> tuple[int, int]:
        """Размер пула и число свободных соединений (0, 0 — если API пула иной)."""
        with contextlib.suppress(Exception):
            return int(self._pool.get_size()), int(self._pool.get_idle_size())
        return 0, 0

    # -- дашборд -----------------------------------------------------------
    async def fetch_dashboard(self) -> Mapping[str, Any]:
        """Собирает все агрегаты дашборда пакетом запросов."""
        async with self._translated():
            mail = dict(await self._pool.fetchrow(SQL_DASHBOARD_MAIL) or {})
            spam_totals = dict(await self._pool.fetchrow(SQL_DASHBOARD_SPAM_TOTALS) or {})
            spam_tags = await self._pool.fetch(SQL_DASHBOARD_SPAM_TAGS)
            spam_latest = await self._pool.fetch(SQL_DASHBOARD_SPAM_LATEST)
            vacancies = dict(await self._pool.fetchrow(SQL_DASHBOARD_VACANCIES) or {})
            rzhd = dict(await self._pool.fetchrow(SQL_DASHBOARD_RZHD) or {})
            ai = dict(await self._pool.fetchrow(SQL_DASHBOARD_AI) or {})
        return {
            "mail": {
                "accounts": int(mail.get("accounts") or 0),
                "folders_synced": int(mail.get("folders_synced") or 0),
                "folders_watched": int(mail.get("folders_watched") or 0),
                "folders_skipped": int(mail.get("folders_skipped") or 0),
                "emails_total": int(mail.get("emails_total") or 0),
                "emails_new": int(mail.get("emails_new") or 0),
                "emails_classified": int(mail.get("emails_classified") or 0),
                "last_sync_at": mail.get("last_sync_at"),
            },
            "valuable_spam": {
                "total": int(spam_totals.get("total") or 0),
                "last_7_days": int(spam_totals.get("last_7_days") or 0),
                "top_tags": [
                    {"tag": str(row["tag"]), "count": int(row["count"])} for row in spam_tags
                ],
                "latest": [dict(row) for row in spam_latest],
            },
            "vacancies": {
                "total": int(vacancies.get("total") or 0),
                "active": int(vacancies.get("active") or 0),
                "ignored": int(vacancies.get("ignored") or 0),
                "by_work_format": {
                    "remote": int(vacancies.get("remote") or 0),
                    "hybrid": int(vacancies.get("hybrid") or 0),
                    "office": int(vacancies.get("office") or 0),
                    "unknown": int(vacancies.get("unknown_count") or 0),
                },
                "last_published_at": vacancies.get("last_published_at"),
            },
            "rzhd": {
                "total": int(rzhd.get("total") or 0),
                "watching": int(rzhd.get("watching") or 0),
                "available": int(rzhd.get("available") or 0),
                "booked": int(rzhd.get("booked") or 0),
                "nearest_travel_date": rzhd.get("nearest_travel_date"),
                "cheapest_price_rub": rzhd.get("cheapest_price_rub"),
            },
            "ai": {
                "classifier_model": ai.get("classifier_model"),
                "fallback_model": ai.get("fallback_model"),
                "max_tokens": ai.get("max_tokens"),
                "instructions_active": int(ai.get("instructions_active") or 0),
            },
        }

    # -- почтовые папки ----------------------------------------------------
    async def list_folders(
        self,
        *,
        account_id: int | None = None,
        scan_mode: str | None = None,
        is_selectable: bool | None = None,
    ) -> list[Mapping[str, Any]]:
        """Папки ящика(ов) с вычисленным ``scan_mode``."""
        query = SQL_FOLDER_SELECT
        clauses: list[str] = []
        args: list[Any] = []
        if account_id is not None:
            args.append(account_id)
            clauses.append(f"account_id = ${len(args)}")
        if is_selectable is not None:
            args.append(is_selectable)
            clauses.append(f"is_selectable = ${len(args)}")
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY account_id, name"
        async with self._translated():
            rows = await self._pool.fetch(query, *args)
        folders = [_folder_row_to_dict(row) for row in rows]
        if scan_mode is not None:
            folders = [folder for folder in folders if folder["scan_mode"] == scan_mode]
        return folders

    async def update_folder(
        self,
        folder_id: int,
        *,
        is_selectable: bool | None,
        scan_mode: str | None,
    ) -> Mapping[str, Any] | None:
        """Чтение-изменение-запись в одной транзакции (``SELECT ... FOR UPDATE``)."""
        updated: Mapping[str, Any] | None = None
        async with self._translated():
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    current = await conn.fetchrow(SQL_FOLDER_LOCK, folder_id)
                    if current is None:
                        return None
                    data = dict(current)
                    flags = list(data.get("flags") or [])
                    new_selectable = (
                        bool(data.get("is_selectable"))
                        if is_selectable is None
                        else is_selectable
                    )
                    mode = scan_mode or derive_scan_mode(flags, new_selectable)
                    updated = await conn.fetchrow(
                        SQL_FOLDER_UPDATE,
                        folder_id,
                        _with_scan_flag(flags, mode),
                        new_selectable,
                    )
        return _folder_row_to_dict(updated) if updated is not None else None

    # -- лента писем -------------------------------------------------------
    async def list_emails(
        self,
        *,
        limit: int,
        category: str | None = None,
        folder_id: int | None = None,
        status: str | None = None,
    ) -> list[Mapping[str, Any]]:
        """Свежие письма первыми; фильтры уходят в SQL, папка — через JOIN."""
        clauses: list[str] = []
        args: list[Any] = []
        if category is not None:
            args.append(category)
            clauses.append(f"e.category = ${len(args)}")
        if folder_id is not None:
            args.append(folder_id)
            clauses.append(f"e.folder_id = ${len(args)}")
        if status is not None:
            args.append(status)
            clauses.append(f"e.status = ${len(args)}")
        query = SQL_EMAIL_SELECT
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        args.append(limit)
        query += f" ORDER BY e.created_at DESC, e.id DESC LIMIT ${len(args)}"
        async with self._translated():
            rows = await self._pool.fetch(query, *args)
        return [dict(row) for row in rows]

    # -- вакансии ----------------------------------------------------------
    async def list_vacancies(
        self,
        *,
        status: str | None = None,
        work_format: str | None = None,
        is_ignored: bool | None = None,
        query: str | None = None,
        limit: int,
        offset: int,
    ) -> tuple[list[Mapping[str, Any]], int]:
        """Страница вакансий (фильтры по статусу, формату работы и игнору)."""
        clauses: list[str] = []
        args: list[Any] = []
        if status is not None:
            args.append(status)
            clauses.append(f"v.status = ${len(args)}")
        if work_format is not None:
            args.append(work_format)
            clauses.append(f"{WORK_FORMAT_SQL.format(alias='v')} = ${len(args)}")
        if is_ignored is not None:
            args.append(is_ignored)
            clauses.append(f"{IGNORED_SQL.format(alias='v')} = ${len(args)}")
        if query:
            args.append(f"%{query}%")
            clauses.append(f"(v.title ILIKE ${len(args)} OR v.company ILIKE ${len(args)})")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        total_sql = "SELECT count(*) FROM vacancies v" + where
        page_sql = (
            f"SELECT {_vacancy_columns('v')} FROM vacancies v{where}"
            f" ORDER BY v.published_at DESC NULLS LAST, v.id DESC"
            f" LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}"
        )
        async with self._translated():
            total = await self._pool.fetchval(total_sql, *args)
            rows = await self._pool.fetch(page_sql, *args, limit, offset)
        return [dict(row) for row in rows], int(total or 0)

    async def create_vacancy(
        self, record: Mapping[str, Any]
    ) -> tuple[Mapping[str, Any], bool]:
        """UPSERT по ``UNIQUE (source, external_id)``; дубли не создаются."""
        api_meta = {
            key: record.get(key)
            for key in ("work_format", "is_ignored", "description")
            if record.get(key) is not None
        }
        args: tuple[Any, ...] = (
            record["source"],
            record["external_id"],
            record["title"],
            record.get("company", ""),
            list(record.get("stack") or []),
            list(record.get("tags") or []),
            record.get("salary_min"),
            record.get("salary_max"),
            record.get("currency", "RUB"),
            record.get("url"),
            record.get("published_at"),
            record.get("status", "new"),
            record.get("score"),
            json.dumps(api_meta, ensure_ascii=False),
        )
        row: Mapping[str, Any] | None = None
        created = False
        async with self._translated():
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    inserted = await conn.fetchrow(SQL_VACANCY_INSERT, *args)
                    created = inserted is not None
                    vacancy_id = inserted["id"] if inserted is not None else None
                    if vacancy_id is None:
                        updated = await conn.fetchrow(SQL_VACANCY_UPDATE_BY_KEY, *args)
                        vacancy_id = updated["id"] if updated is not None else None
                    if vacancy_id is None:
                        raise DatabaseUnavailable("vacancies: UPSERT не вернул id")
                    row = await conn.fetchrow(
                        SQL_VACANCY_BY_ID.format(columns=_vacancy_columns("v")), vacancy_id
                    )
        if row is None:
            raise DatabaseUnavailable("vacancies: строка не найдена после UPSERT")
        return dict(row), created

    async def update_vacancy(
        self, vacancy_id: int, changes: Mapping[str, Any]
    ) -> Mapping[str, Any] | None:
        """PATCH вакансии: UI-атрибуты уходят в ``raw.api``."""
        api_meta = {
            key: changes[key]
            for key in ("work_format", "is_ignored")
            if key in changes and changes[key] is not None
        }
        sql = SQL_VACANCY_PATCH.format(columns=_vacancy_columns("v"))
        args: tuple[Any, ...] = (
            vacancy_id,
            changes.get("status"),
            changes.get("score"),
            changes.get("url"),
            changes.get("title"),
            changes.get("company"),
            json.dumps(api_meta, ensure_ascii=False),
        )
        async with self._translated():
            row = await self._pool.fetchrow(sql, *args)
        return dict(row) if row is not None else None

    async def hide_vacancy(self, vacancy_id: int) -> Mapping[str, Any] | None:
        """Мягкое скрытие: ``raw.api.is_ignored = TRUE`` (физический DELETE запрещён)."""
        sql = SQL_VACANCY_PATCH.format(columns=_vacancy_columns("v"))
        async with self._translated():
            row = await self._pool.fetchrow(
                sql,
                vacancy_id,
                None,
                None,
                None,
                None,
                None,
                json.dumps({"is_ignored": True}),
            )
        return dict(row) if row is not None else None

    # -- билеты РЖД --------------------------------------------------------
    async def list_tickets(
        self,
        *,
        status: str | None = None,
        car_type: str | None = None,
        direction_from: str | None = None,
        direction_to: str | None = None,
        travel_date_from: date | None = None,
        travel_date_to: date | None = None,
        only_available: bool | None = None,
        limit: int,
        offset: int,
    ) -> tuple[list[Mapping[str, Any]], int]:
        """Страница рейсов: сначала ближайшие и самые дешёвые."""
        clauses: list[str] = []
        args: list[Any] = []
        if status is not None:
            args.append(status)
            clauses.append(f"status = ${len(args)}")
        if car_type is not None:
            args.append(car_type)
            clauses.append(f"car_type = ${len(args)}")
        if direction_from:
            args.append(f"%{direction_from}%")
            clauses.append(f"direction_from ILIKE ${len(args)}")
        if direction_to:
            args.append(f"%{direction_to}%")
            clauses.append(f"direction_to ILIKE ${len(args)}")
        if travel_date_from is not None:
            args.append(travel_date_from)
            clauses.append(f"travel_date >= ${len(args)}")
        if travel_date_to is not None:
            args.append(travel_date_to)
            clauses.append(f"travel_date <= ${len(args)}")
        if only_available:
            clauses.append("seats_available > 0")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        total_sql = "SELECT count(*) FROM rzhd_tickets" + where
        page_sql = (
            SQL_TICKET_SELECT
            + where
            + " ORDER BY travel_date ASC, price_rub ASC NULLS LAST, id ASC"
            + f" LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}"
        )
        async with self._translated():
            total = await self._pool.fetchval(total_sql, *args)
            rows = await self._pool.fetch(page_sql, *args, limit, offset)
        return [dict(row) for row in rows], int(total or 0)

    async def create_ticket(
        self, record: Mapping[str, Any]
    ) -> tuple[Mapping[str, Any], bool]:
        """UPSERT по параметрам предложения (идемпотентный опрос вотчера)."""
        raw = record.get("raw")
        args: tuple[Any, ...] = (
            record["direction_from"],
            record["direction_to"],
            record["travel_date"],
            record.get("train_number", ""),
            record["car_type"],
            record.get("seats_available", 0),
            record.get("price_rub"),
            record.get("booking_url"),
            record.get("status", "watching"),
            record.get("passenger_name"),
            record.get("trip_window_start"),
            record.get("trip_window_end"),
            json.dumps(raw, ensure_ascii=False) if raw is not None else None,
        )
        row: Mapping[str, Any] | None = None
        created = False
        async with self._translated():
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    inserted = await conn.fetchrow(SQL_TICKET_INSERT, *args)
                    created = inserted is not None
                    ticket_id = inserted["id"] if inserted is not None else None
                    if ticket_id is None:
                        updated = await conn.fetchrow(SQL_TICKET_UPDATE_BY_KEY, *args)
                        ticket_id = updated["id"] if updated is not None else None
                    if ticket_id is None:
                        raise DatabaseUnavailable("rzhd_tickets: UPSERT не вернул id")
                    row = await conn.fetchrow(SQL_TICKET_BY_ID, ticket_id)
        if row is None:
            raise DatabaseUnavailable("rzhd_tickets: строка не найдена после UPSERT")
        return dict(row), created

    # -- ИИ: конфиг и запись результата ------------------------------------
    async def fetch_ai_instruction(self, scope_key: str) -> Mapping[str, Any] | None:
        """Промпт и лимиты из ``ai_instructions`` (RLS отдаёт только ``is_active``)."""
        async with self._translated():
            row = await self._pool.fetchrow(SQL_AI_INSTRUCTION, scope_key)
        return dict(row) if row is not None else None

    async def resolve_account_id(self, account_id: int | None) -> int | None:
        """Ящик для записи письма: явный id или первый активный (RLS)."""
        async with self._translated():
            if account_id is None:
                return await self._pool.fetchval(SQL_FIRST_ACTIVE_ACCOUNT)
            row = await self._pool.fetchrow(SQL_ACCOUNT_BY_ID, account_id)
        return int(row["id"]) if row is not None else None

    async def save_email_classification(self, **fields: Any) -> int:
        """UPSERT письма: дедупликация по ``(account_id, external_id)``."""
        args: tuple[Any, ...] = (
            fields["account_id"],
            fields["external_id"],
            fields["sender"],
            fields["sender_name"],
            fields["subject"],
            fields["received_at"],
            fields["category"],
            fields["priority"],
            fields["summary"],
            fields["spam_tag"],
            fields["spam_url"],
            fields["status"],
            fields["ai_model"],
            bool(fields.get("is_deleted", False)),
        )
        async with self._translated():
            email_id = await self._pool.fetchval(SQL_EMAIL_UPSERT, *args)
        if email_id is None:
            raise DatabaseUnavailable("emails: UPSERT не вернул id")
        return int(email_id)

    async def upsert_valuable_spam(self, **fields: Any) -> int:
        """UPSERT выжимки: ``UNIQUE (email_id)`` не даёт дублей при перечитывании."""
        args: tuple[Any, ...] = (
            fields["email_id"],
            fields["account_id"],
            fields["spam_tag"],
            fields["spam_url"],
            fields["summary"],
            fields["sender"],
            fields["subject"],
            fields["received_at"],
        )
        async with self._translated():
            spam_id = await self._pool.fetchval(SQL_VALUABLE_SPAM_UPSERT, *args)
        if spam_id is None:
            raise DatabaseUnavailable("valuable_spam: UPSERT не вернул id")
        return int(spam_id)

    async def insert_ai_vacancy(self, **fields: Any) -> int:
        """Сохраняет вакансию, размеченную моделью (``source = 'ai-preview'``)."""
        api_meta = {
            "work_format": fields.get("work_format"),
            "category": fields.get("category"),
            "summary": fields.get("summary"),
        }
        args: tuple[Any, ...] = (
            fields.get("source", "ai-preview"),
            fields["external_id"],
            fields["title"],
            fields.get("company", ""),
            list(fields.get("stack") or []),
            fields.get("salary_min"),
            fields.get("salary_max"),
            fields.get("url"),
            int(fields.get("score") or 0),
            json.dumps(api_meta, ensure_ascii=False),
        )
        async with self._translated():
            vacancy_id = await self._pool.fetchval(SQL_AI_VACANCY_INSERT, *args)
        if vacancy_id is None:
            raise DatabaseUnavailable("vacancies: INSERT из AI-preview не вернул id")
        return int(vacancy_id)


# ---------------------------------------------------------------------------
# LLM-клиент и каскад (DeepSeek / OpenRouter, Structured Output).
# ---------------------------------------------------------------------------
class LlmClient(Protocol):
    """Минимальный контракт LLM-клиента: один chat-completion, возвращает текст."""

    async def complete(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, str]],
        max_tokens: int,
        temperature: float | None,
        json_mode: bool,
    ) -> str:
        """Возвращает ``choices[0].message.content`` модели."""


def completion_text(response: Any) -> str:
    """Достаёт текст ответа модели (поддерживает объекты SDK и словари тестов).

    :raises LlmUnavailable: ответ пустой или не содержит ``choices``.
    """
    choices = getattr(response, "choices", None)
    if choices is None and isinstance(response, Mapping):
        choices = response.get("choices")
    if not choices:
        raise LlmUnavailable("model response has no choices")
    first = choices[0]
    message = getattr(first, "message", None)
    if message is None and isinstance(first, Mapping):
        message = first.get("message")
    if message is None:
        raise LlmUnavailable("model response has no message")
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
        raise LlmUnavailable("model returned empty content")
    return text[:MAX_AI_RESPONSE_CHARS]


class OpenRouterLlmClient:
    """``AsyncOpenAI``-клиент для DeepSeek и OpenRouter (OpenAI-совместимый API).

    Повторы и таймауты живут в каскаде (:func:`classify_with_cascade`), поэтому
    SDK-ретраи отключены: ``max_retries=0`` — иначе бюджет токенов умножается.
    """

    def __init__(self, settings: ApiSettings) -> None:
        """Создаёт клиент; ``ImportError`` — нет пакета ``openai``."""
        from openai import AsyncOpenAI  # noqa: PLC0415 - тяжёлая зависимость

        headers: dict[str, str] = {}
        if settings.provider == "openrouter":
            headers = {
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "AI Dev Navigator",
            }
        self._client = AsyncOpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
            default_headers=headers or None,
            max_retries=0,
        )

    async def complete(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, str]],
        max_tokens: int,
        temperature: float | None,
        json_mode: bool,
    ) -> str:
        """Один запрос к модели; JSON-режим с откатом для провайдеров без него."""
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [dict(message) for message in messages],
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            response = await self._client.chat.completions.create(**kwargs)
        except Exception:  # noqa: BLE001 - провайдер мог отвергнуть response_format
            if not json_mode:
                raise
            kwargs.pop("response_format", None)
            response = await self._client.chat.completions.create(**kwargs)
        return completion_text(response)

    async def aclose(self) -> None:
        """Закрывает HTTP-пул SDK (ошибки обрабатывает вызывающий код)."""
        await self._client.close()


@dataclass(frozen=True, slots=True)
class CascadeResult:
    """Итог каскада: вердикт, фактическая модель, число попыток, задержка."""

    classification: AiClassification
    used_model: str
    attempts: int
    fallback_used: bool
    latency_ms: int


def _normalize_model(name: Any, default: str) -> str:
    """Пустое/мусорное имя модели из ``ai_instructions`` → значение по умолчанию."""
    text = str(name or "").strip()
    aliases = {
        "deepseek-reasoning": "deepseek-reasoner",
        "deepseek-r1": "deepseek-reasoner",
        "deepseek-v3": "deepseek-chat",
    }
    if not text:
        return default
    return aliases.get(text.lower(), text)


def _resolve_budget(instruction: Mapping[str, Any] | None, settings: ApiSettings) -> int:
    """Бюджет ответа: ``ai_instructions.max_tokens`` (кап 1024) или дефолт настроек."""
    raw = instruction.get("max_tokens") if instruction else None
    try:
        budget = int(raw)
    except (TypeError, ValueError):
        budget = settings.max_tokens
    return max(64, min(MAX_AI_TOKENS_CAP, budget))


def _resolve_temperature(
    instruction: Mapping[str, Any] | None, settings: ApiSettings
) -> float:
    """Температура из ``ai_instructions`` (0..2) или дефолт настроек."""
    raw = instruction.get("temperature") if instruction else None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return settings.temperature
    return max(0.0, min(2.0, value))


def build_messages(payload: ClassifyPreviewRequest, prompt: str) -> list[dict[str, str]]:
    """Собирает system+user сообщения: жёсткий JSON-контракт + усечённый текст."""
    system = f"{prompt.strip() or DEFAULT_CLASSIFIER_PROMPT}\n\n{JSON_CONTRACT}"
    body = payload.text[:MAX_AI_INPUT_CHARS]
    if payload.kind == "email":
        user = (
            "Тип: письмо\n"
            f"Отправитель: {payload.sender_name or '(без имени)'} <{payload.sender or '?'}>\n"
            f"Тема: {payload.subject or '(без темы)'}\n"
            f"Текст:\n{body}"
        )
    else:
        title = payload.vacancy_title or payload.subject or "(без названия)"
        stack = ", ".join(payload.stack) if payload.stack else "(не указан)"
        user = (
            "Тип: вакансия\n"
            f"Должность: {title}\n"
            f"Компания: {payload.company or '(не указана)'}\n"
            f"Стек: {stack}\n"
            f"URL: {payload.url or '(нет)'}\n"
            f"Описание:\n{body}"
        )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def classify_with_cascade(
    llm: LlmClient,
    settings: ApiSettings,
    *,
    model: str,
    fallback_model: str,
    messages: Sequence[Mapping[str, str]],
    max_tokens: int,
    temperature: float,
) -> CascadeResult:
    """Каскад: 3 попытки на основную модель → 3 на резервную, таймаут 15 с.

    Стоимость контролируется ``max_tokens`` (из ``ai_instructions``), числом попыток
    и жёстким ``asyncio.wait_for``: «зависший» провайдер не держит запрос дольше
    ``timeout_sec``. Нарушение JSON-контракта — тоже повод для повтора, но с
    напоминанием формата в диалоге.

    :raises LlmUnavailable: обе модели не смогли вернуть валидный вердикт.
    """
    started = time.perf_counter()
    candidates = [model]
    if fallback_model and fallback_model != model:
        candidates.append(fallback_model)
    attempts_limit = max(1, settings.retry_attempts)
    attempts = 0
    errors: list[str] = []
    conversation: list[dict[str, str]] = [dict(message) for message in messages]
    for index, candidate in enumerate(candidates):
        for attempt in range(1, attempts_limit + 1):
            attempts += 1
            try:
                raw = await asyncio.wait_for(
                    llm.complete(
                        model=candidate,
                        messages=conversation,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        json_mode=settings.json_mode,
                    ),
                    timeout=settings.timeout_sec,
                )
            except asyncio.TimeoutError:
                errors.append(f"{candidate}#{attempt}: timeout {settings.timeout_sec:g}s")
            except LlmUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001 - сеть/5xx/429 провайдера
                errors.append(f"{candidate}#{attempt}: {type(exc).__name__}: {exc}")
            else:
                try:
                    classification = parse_classification(raw)
                except ClassificationError as exc:
                    errors.append(f"{candidate}#{attempt}: {exc}")
                    conversation.append({"role": "assistant", "content": raw[:MAX_AI_RESPONSE_CHARS]})
                    conversation.append({"role": "user", "content": RETRY_INSTRUCTION})
                else:
                    return CascadeResult(
                        classification=classification,
                        used_model=candidate,
                        attempts=attempts,
                        fallback_used=index > 0,
                        latency_ms=int((time.perf_counter() - started) * 1000),
                    )
            if attempt < attempts_limit:
                delay = min(
                    settings.retry_base_delay_sec * (2 ** (attempt - 1)),
                    MAX_AI_RETRY_DELAY_SEC,
                )
                if delay > 0:
                    await asyncio.sleep(delay)
    raise LlmUnavailable(
        f"all models failed after {attempts} attempt(s): {'; '.join(errors[-4:])}"
    )


async def persist_email(
    payload: ClassifyPreviewRequest,
    gateway: DatabaseGateway,
    result: CascadeResult,
) -> tuple[int, int | None]:
    """Сохраняет письмо и (для ``SPAM_VALUABLE``) выжимку в ``valuable_spam``.

    :raises DatabaseUnavailable: нет активных ящиков или запись отклонена RLS.
    """
    account_id = await gateway.resolve_account_id(payload.account_id)
    if account_id is None:
        raise DatabaseUnavailable(
            "нет активных почтовых ящиков в mail_accounts: запись письма невозможна"
        )
    received_at = payload.received_at or datetime.now(timezone.utc)
    external_id = payload.external_id or _hash_external_id(
        payload.sender,
        payload.subject,
        received_at.isoformat(timespec="seconds"),
    )
    classification = result.classification
    is_spam_valuable = classification.category == "SPAM_VALUABLE"
    email_id = await gateway.save_email_classification(
        account_id=account_id,
        external_id=external_id,
        sender=payload.sender,
        sender_name=payload.sender_name,
        subject=payload.subject,
        received_at=received_at,
        category=classification.category,
        priority=classification.priority,
        summary=classification.summary,
        spam_tag=classification.spam_tag,
        spam_url=classification.spam_url,
        status="deleted" if is_spam_valuable else "classified",
        ai_model=result.used_model,
        is_deleted=is_spam_valuable,
    )
    spam_id: int | None = None
    if is_spam_valuable:
        spam_id = await gateway.upsert_valuable_spam(
            email_id=email_id,
            account_id=account_id,
            spam_tag=classification.spam_tag,
            spam_url=classification.spam_url,
            summary=classification.summary,
            sender=payload.sender,
            subject=payload.subject,
            received_at=received_at,
        )
    return email_id, spam_id


async def persist_vacancy(
    payload: ClassifyPreviewRequest,
    gateway: DatabaseGateway,
    result: CascadeResult,
) -> int:
    """Сохраняет вакансию с вердиктом модели (``source = 'ai-preview'``)."""
    classification = result.classification
    title = payload.vacancy_title or payload.subject or "Вакансия из AI-preview"
    external_id = payload.external_id or _hash_external_id(
        payload.company, title, payload.url or ""
    )
    return await gateway.insert_ai_vacancy(
        source="ai-preview",
        external_id=external_id,
        title=title,
        company=payload.company,
        url=payload.url,
        stack=list(payload.stack),
        salary_min=payload.salary_min,
        salary_max=payload.salary_max,
        work_format=classification.work_format,
        score=100 if classification.category == "VACANCY" else 50,
        summary=classification.summary,
        category=classification.category,
    )


async def run_classification(
    payload: ClassifyPreviewRequest,
    gateway: DatabaseGateway,
    llm: LlmClient,
    settings: ApiSettings,
) -> ClassifyPreviewResponse:
    """Сквозной сценарий AI-фичи: конфиг из БД → каскад LLM → запись в БД → ответ."""
    instruction = await gateway.fetch_ai_instruction("classifier")
    model = _normalize_model(
        instruction.get("model") if instruction else None, settings.model
    )
    fallback_model = _normalize_model(
        instruction.get("fallback_model") if instruction else None,
        settings.fallback_model,
    )
    budget = _resolve_budget(instruction, settings)
    temperature = _resolve_temperature(instruction, settings)
    prompt = str((instruction or {}).get("prompt") or DEFAULT_CLASSIFIER_PROMPT)
    messages = build_messages(payload, prompt)
    result = await classify_with_cascade(
        llm,
        settings,
        model=model,
        fallback_model=fallback_model,
        messages=messages,
        max_tokens=budget,
        temperature=temperature,
    )
    persisted = PersistedRecords()
    if payload.persist:
        if payload.kind == "email":
            email_id, spam_id = await persist_email(payload, gateway, result)
            persisted = PersistedRecords(email_id=email_id, valuable_spam_id=spam_id)
        else:
            persisted = PersistedRecords(
                vacancy_id=await persist_vacancy(payload, gateway, result)
            )
    return ClassifyPreviewResponse(
        kind=payload.kind,
        classification=result.classification,
        ai=AiRun(
            provider=settings.provider,
            model=model,
            used_model=result.used_model,
            fallback_model=fallback_model,
            fallback_used=result.fallback_used,
            attempts=result.attempts,
            max_tokens=budget,
            temperature=temperature,
            timeout_sec=settings.timeout_sec,
            latency_ms=result.latency_ms,
            json_mode=settings.json_mode,
        ),
        persisted=persisted,
    )


# ---------------------------------------------------------------------------
# Зависимости FastAPI: настройки, шлюз БД, LLM-клиент.
# ---------------------------------------------------------------------------
def get_settings(request: Request) -> ApiSettings:
    """Настройки приложения (кладёт ``create_app``; тесты подменяют через state)."""
    settings = getattr(request.app.state, "settings", None)
    if not isinstance(settings, ApiSettings):
        raise RuntimeError("ApiSettings не инициализированы: create_app не вызывался")
    return settings


def get_gateway(request: Request) -> DatabaseGateway:
    """Шлюз БД; ``DatabaseUnavailable`` → 503 (пул не создан или БД упала)."""
    gateway = getattr(request.app.state, "gateway", None)
    if gateway is None:
        raise DatabaseUnavailable(
            "пул asyncpg не создан: DATABASE_URL не задан или PostgreSQL недоступна"
        )
    return gateway


def get_llm(request: Request) -> LlmClient:
    """LLM-клиент; ``LlmUnavailable`` → 502 (нет ключа или SDK не установлен)."""
    llm = getattr(request.app.state, "llm", None)
    if llm is None:
        raise LlmUnavailable(
            "LLM-клиент не создан: задайте ENV_DEEPSEEK_API_KEY (или OPENROUTER_API_KEY)"
        )
    return llm


async def probe_database(
    gateway: DatabaseGateway | None, settings: ApiSettings
) -> DatabaseHealth:
    """Проверяет БД «мягко»: ``/health`` отвечает 200 даже при недоступной БД."""
    target = settings.masked_dsn or None
    if gateway is None:
        return DatabaseHealth(status="unavailable", target=target)
    try:
        latency_ms = await gateway.ping()
        pool_size, pool_free = await gateway.pool_stats()
    except DatabaseUnavailable:
        return DatabaseHealth(status="unavailable", target=target)
    return DatabaseHealth(
        status="ok",
        latency_ms=int(round(latency_ms)),
        pool_size=pool_size,
        pool_free=pool_free,
        target=target,
    )


# ---------------------------------------------------------------------------
# Одноразовая синхронизация папок: переиспользуем штатный режим воркера
# (``agents/mail_worker.py --sync-folders``), а не дублируем IMAP-код в API.
# ---------------------------------------------------------------------------
FOLDER_SYNC_SCRIPT: Path = PROJECT_ROOT / "agents" / "mail_worker.py"
FOLDER_SYNC_CONFIG: Path = PROJECT_ROOT / "config" / "orchestrator.json"
FOLDER_SYNC_TIMEOUT_SEC: float = 180.0
FOLDER_SYNC_SUMMARY_RE = re.compile(r"папок сохранено=(\d+),\s*ошибок=(\d+)")
FOLDER_SYNC_DETAIL_CHARS: int = 300


@dataclass(slots=True)
class FolderSyncRun:
    """Результат запуска ``--sync-folders``: коды, счётчики и причина сбоя."""

    exit_code: int
    folders_saved: int | None
    failures: int
    duration_ms: int
    detail: str | None
    timed_out: bool = False


def _tail_line(output: str) -> str | None:
    """Последняя непустая строка лога (в ``detail`` не тащим весь вывод)."""
    for line in reversed(output.splitlines()):
        text = line.strip()
        if text:
            return text[:FOLDER_SYNC_DETAIL_CHARS]
    return None


def _decode_process_output(raw: bytes) -> str:
    """Декодирует вывод воркера: UTF-8, затем локальная кодировка Windows.

    Воркер пишет диагностику в ``stderr`` кодировкой консоли (cp1251 в русской
    Windows), поэтому жёсткий ``utf-8`` превращал бы ``detail`` в mojibake.
    """
    data = raw or b""
    encodings = ("utf-8", locale.getpreferredencoding(False), "cp1251", "cp866")
    for encoding in encodings:
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


async def run_folder_sync(
    timeout_sec: float = FOLDER_SYNC_TIMEOUT_SEC,
) -> FolderSyncRun:
    """Запускает ``mail_worker.py --sync-folders`` отдельным процессом.

    Синхронизация идёт по IMAP и пишет ``mail_folders`` под ролью
    ``navigator_worker``; API лишь оркестрирует вызов и не дублирует код воркера.
    Таймаут убивает процесс: кнопка на ``/email`` не должна «висеть».
    """
    started = time.perf_counter()
    if not FOLDER_SYNC_SCRIPT.exists():
        return FolderSyncRun(
            exit_code=-1,
            folders_saved=None,
            failures=0,
            duration_ms=0,
            detail=f"скрипт не найден: {FOLDER_SYNC_SCRIPT}",
        )

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(FOLDER_SYNC_SCRIPT),
        "--config",
        str(FOLDER_SYNC_CONFIG),
        "--sync-folders",
        cwd=str(PROJECT_ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timed_out = False
    raw_out = b""
    raw_err = b""
    try:
        raw_out, raw_err = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        timed_out = True
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(Exception):
            await process.wait()

    duration_ms = int(round((time.perf_counter() - started) * 1000))
    output = _decode_process_output(raw_err)
    if not output.strip():
        output = _decode_process_output(raw_out)

    folders_saved: int | None = None
    failures = 0
    match = FOLDER_SYNC_SUMMARY_RE.search(output)
    if match is not None:
        folders_saved = int(match.group(1))
        failures = int(match.group(2))

    if timed_out:
        detail: str | None = f"таймаут синхронизации ({timeout_sec:g} с)"
        exit_code = -1
    else:
        detail = _tail_line(output)
        exit_code = int(process.returncode or 0)

    return FolderSyncRun(
        exit_code=exit_code,
        folders_saved=folders_saved,
        failures=failures,
        duration_ms=duration_ms,
        detail=detail,
        timed_out=timed_out,
    )


router = APIRouter(prefix=API_PREFIX)


# ---------------------------------------------------------------------------
# Системные ручки и дашборд.
# ---------------------------------------------------------------------------
@router.get(
    "/health",
    response_model=HealthResponse,
    tags=["system"],
    summary="Здоровье API, PostgreSQL и LLM-провайдера",
)
async def health(
    request: Request, settings: ApiSettings = Depends(get_settings)
) -> HealthResponse:
    """Всегда 200: сервис жив, даже если БД недоступна (``status = degraded``)."""
    database = await probe_database(getattr(request.app.state, "gateway", None), settings)
    return HealthResponse(
        status="ok" if database.status == "ok" else "degraded",
        version=settings.version,
        generated_at=datetime.now(timezone.utc),
        database=database,
        ai=AiProviderHealth(
            provider=settings.provider,
            base_url=settings.base_url,
            ready=settings.ready,
            model=settings.model,
            fallback_model=settings.fallback_model,
        ),
    )


@router.get(
    "/dashboard/summary",
    response_model=DashboardSummary,
    tags=["dashboard"],
    summary="Агрегированная сводка для Bento-карточек",
    responses={503: {"description": "PostgreSQL недоступна (db_unavailable)"}},
)
async def dashboard_summary(
    gateway: DatabaseGateway = Depends(get_gateway),
    settings: ApiSettings = Depends(get_settings),
) -> DashboardSummary:
    """Письма, полезный спам, вакансии, РЖД, лимиты ИИ и здоровье БД — одним ответом."""
    database = await probe_database(gateway, settings)
    data = await gateway.fetch_dashboard()
    return DashboardSummary(
        generated_at=datetime.now(timezone.utc),
        database=database,
        mail=data["mail"],
        valuable_spam=data["valuable_spam"],
        vacancies=data["vacancies"],
        rzhd=data["rzhd"],
        ai=data["ai"],
    )


# ---------------------------------------------------------------------------
# Почтовые папки.
# ---------------------------------------------------------------------------
@router.get(
    "/mail/folders",
    response_model=MailFolderList,
    tags=["mail"],
    summary="Снимок папок IMAP с режимом сканирования",
)
async def list_mail_folders(
    account_id: int | None = Query(default=None, ge=1, description="Фильтр по ящику"),
    scan_mode: ScanMode | None = Query(default=None, description="Режим сканирования"),
    is_selectable: bool | None = Query(default=None, description="Выбранные папки"),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> MailFolderList:
    """Список папок; ``scan_mode`` вычисляется из токена ``NAV_SCAN:*``."""
    rows = await gateway.list_folders(
        account_id=account_id, scan_mode=scan_mode, is_selectable=is_selectable
    )
    items = [MailFolder.model_validate(row) for row in rows]
    return MailFolderList(items=items, total=len(items))


@router.patch(
    "/mail/folders/{folder_id}",
    response_model=MailFolder,
    tags=["mail"],
    summary="Режим сканирования / выбор папки",
    responses={404: {"description": "Папка не найдена"}, 503: {"description": "БД недоступна"}},
)
async def patch_mail_folder(
    folder_id: int,
    payload: MailFolderPatch,
    gateway: DatabaseGateway = Depends(get_gateway),
) -> MailFolder:
    """Обновляет ``scan_mode`` и/или ``is_selectable`` (транзакционно)."""
    row = await gateway.update_folder(
        folder_id, is_selectable=payload.is_selectable, scan_mode=payload.scan_mode
    )
    if row is None:
        raise not_found("папка", folder_id)
    return MailFolder.model_validate(row)


# ---------------------------------------------------------------------------
# Лента писем и синхронизация папок.
# ---------------------------------------------------------------------------
@router.get(
    "/emails",
    response_model=EmailList,
    tags=["mail"],
    summary="Последние обработанные письма из PostgreSQL (created_at DESC)",
    responses={503: {"description": "PostgreSQL недоступна (db_unavailable)"}},
)
async def list_emails(
    limit: int = Query(default=20, ge=1, le=200, description="Размер ленты"),
    category: Category | None = Query(default=None, description="Категория ИИ"),
    folder_id: int | None = Query(default=None, ge=1, description="Фильтр по папке IMAP"),
    status_filter: EmailStatus | None = Query(
        default=None, alias="status", description="Статус обработки письма"
    ),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> EmailList:
    """Реальные записи ``emails``: тема, отправитель, вердикт ИИ, папка и даты."""
    rows = await gateway.list_emails(
        limit=limit,
        category=category,
        folder_id=folder_id,
        status=status_filter,
    )
    items = [EmailItem.model_validate(row) for row in rows]
    return EmailList(items=items, total=len(items), limit=limit)


@router.post(
    "/mail/sync-folders",
    response_model=FolderSyncResult,
    tags=["mail"],
    summary="Синхронизировать папки IMAP (mail_worker --sync-folders)",
    responses={503: {"description": "PostgreSQL недоступна (db_unavailable)"}},
)
async def sync_mail_folders(
    gateway: DatabaseGateway = Depends(get_gateway),
) -> FolderSyncResult:
    """Одноразовый IMAP LIST → ``mail_folders`` + актуальный размер снимка."""
    run = await run_folder_sync()
    folders = await gateway.list_folders()
    if run.timed_out or run.exit_code != 0:
        state: Literal["ok", "partial", "error"] = "error"
    elif run.failures > 0:
        state = "partial"
    else:
        state = "ok"
    return FolderSyncResult(
        status=state,
        exit_code=run.exit_code,
        folders_saved=run.folders_saved,
        failures=run.failures,
        folders_total=len(folders),
        duration_ms=run.duration_ms,
        detail=run.detail,
    )


# ---------------------------------------------------------------------------
# Вакансии.
# ---------------------------------------------------------------------------
@router.get(
    "/vacancies",
    response_model=VacancyList,
    tags=["vacancies"],
    summary="Список вакансий с фильтрами по статусу и формату работы",
)
async def list_vacancies(
    status_filter: VacancyStatus | None = Query(default=None, alias="status"),
    work_format: WorkFormat | None = Query(default=None, description="remote/hybrid/office"),
    is_ignored: bool | None = Query(default=None, description="false — только активные"),
    q: str | None = Query(default=None, max_length=120, description="Поиск по title/company"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> VacancyList:
    """Страница вакансий; свежие сверху, фильтры прозрачны для SQL."""
    rows, total = await gateway.list_vacancies(
        status=status_filter,
        work_format=work_format,
        is_ignored=is_ignored,
        query=q,
        limit=limit,
        offset=offset,
    )
    return VacancyList(
        items=[Vacancy.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post(
    "/vacancies",
    response_model=Vacancy,
    status_code=http_status.HTTP_201_CREATED,
    tags=["vacancies"],
    summary="Добавить вакансию (UPSERT по source + external_id)",
    responses={200: {"description": "Вакансия уже была — обновлена"}},
)
async def create_vacancy(
    payload: VacancyCreate,
    response: Response,
    gateway: DatabaseGateway = Depends(get_gateway),
) -> Vacancy:
    """Возвращает 201 для новой строки и 200 для повторного POST того же предложения."""
    row, created = await gateway.create_vacancy(payload.to_record())
    if not created:
        response.status_code = http_status.HTTP_200_OK
    return Vacancy.model_validate(row)


@router.patch(
    "/vacancies/{vacancy_id}",
    response_model=Vacancy,
    tags=["vacancies"],
    summary="Игнор по формату работы, статус, оценка",
    responses={404: {"description": "Вакансия не найдена"}},
)
async def patch_vacancy(
    vacancy_id: int,
    payload: VacancyPatch,
    gateway: DatabaseGateway = Depends(get_gateway),
) -> Vacancy:
    """Обновляет переданные поля (``null`` = «не менять»)."""
    row = await gateway.update_vacancy(vacancy_id, payload.to_changes())
    if row is None:
        raise not_found("вакансия", vacancy_id)
    return Vacancy.model_validate(row)


@router.delete(
    "/vacancies/{vacancy_id}",
    response_model=Vacancy,
    tags=["vacancies"],
    summary="Скрыть вакансию (мягкое удаление, is_ignored = TRUE)",
    responses={404: {"description": "Вакансия не найдена"}},
)
async def delete_vacancy(
    vacancy_id: int, gateway: DatabaseGateway = Depends(get_gateway)
) -> Vacancy:
    """Мягкое скрытие вместо DELETE: RLS запрещает ``status = 'archived'``."""
    row = await gateway.hide_vacancy(vacancy_id)
    if row is None:
        raise not_found("вакансия", vacancy_id)
    return Vacancy.model_validate(row)


# ---------------------------------------------------------------------------
# Билеты РЖД.
# ---------------------------------------------------------------------------
@router.get(
    "/rzhd/tickets",
    response_model=RzhdTicketList,
    tags=["rzhd"],
    summary="Найденные билеты РЖД",
)
async def list_rzhd_tickets(
    status_filter: TicketStatus | None = Query(default=None, alias="status"),
    car_type: CarType | None = Query(default=None),
    direction_from: str | None = Query(default=None, max_length=120),
    direction_to: str | None = Query(default=None, max_length=120),
    travel_date_from: date | None = Query(default=None),
    travel_date_to: date | None = Query(default=None),
    only_available: bool | None = Query(default=None, description="Только с местами"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> RzhdTicketList:
    """Ближайшие рейсы первыми, внутри даты — по возрастанию цены."""
    rows, total = await gateway.list_tickets(
        status=status_filter,
        car_type=car_type,
        direction_from=direction_from,
        direction_to=direction_to,
        travel_date_from=travel_date_from,
        travel_date_to=travel_date_to,
        only_available=only_available,
        limit=limit,
        offset=offset,
    )
    return RzhdTicketList(items=[RzhdTicket.model_validate(row) for row in rows], total=total)


@router.post(
    "/rzhd/tickets",
    response_model=RzhdTicket,
    status_code=http_status.HTTP_201_CREATED,
    tags=["rzhd"],
    summary="Добавить/обновить рейс (UPSERT по параметрам предложения)",
    responses={200: {"description": "Рейс уже наблюдался — обновлён"}},
)
async def create_rzhd_ticket(
    payload: RzhdTicketCreate,
    response: Response,
    gateway: DatabaseGateway = Depends(get_gateway),
) -> RzhdTicket:
    """Идемпотентная запись: повторный опрос вотчера не создаёт дубли."""
    row, created = await gateway.create_ticket(payload.to_record())
    if not created:
        response.status_code = http_status.HTTP_200_OK
    return RzhdTicket.model_validate(row)


# ---------------------------------------------------------------------------
# AI-фича: классификация с Structured Output и сохранением результата.
# ---------------------------------------------------------------------------
@router.post(
    "/ai/classify-preview",
    response_model=ClassifyPreviewResponse,
    tags=["ai"],
    summary="Классифицировать письмо/вакансию (LLM + PostgreSQL)",
    responses={
        502: {"description": "LLM недоступна (llm_unavailable)"},
        503: {"description": "БД недоступна (db_unavailable)"},
    },
)
async def classify_preview(
    payload: ClassifyPreviewRequest,
    gateway: DatabaseGateway = Depends(get_gateway),
    llm: LlmClient = Depends(get_llm),
    settings: ApiSettings = Depends(get_settings),
) -> ClassifyPreviewResponse:
    """Текст → LLM (DeepSeek/OpenRouter) → строгая схема → запись в БД → JSON."""
    return await run_classification(payload, gateway, llm, settings)


# ---------------------------------------------------------------------------
# Обработчики ошибок, жизненный цикл и фабрика приложения.
# ---------------------------------------------------------------------------
async def _database_unavailable_handler(
    request: Request, exc: DatabaseUnavailable
) -> JSONResponse:
    """503 ``db_unavailable`` (текст ошибки не содержит DSN и паролей)."""
    return JSONResponse(status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
                        content=_error_payload("db_unavailable", str(exc)))


async def _llm_unavailable_handler(request: Request, exc: LlmUnavailable) -> JSONResponse:
    """502 ``llm_unavailable``: провайдер и промпты в ответ не попадают."""
    return JSONResponse(status_code=http_status.HTTP_502_BAD_GATEWAY,
                        content=_error_payload("llm_unavailable", str(exc)))


async def _startup(app: FastAPI, settings: ApiSettings) -> None:
    """Создаёт пул ``asyncpg`` и LLM-клиент.

    Сбой любого шага не валит сервис: ``/health`` покажет ``degraded``,
    эндпоинты данных вернут 503/502 — это осознанное поведение MVP.
    """
    if settings.database_url:
        try:
            import asyncpg  # noqa: PLC0415 - опциональная тяжёлая зависимость

            pool = await asyncpg.create_pool(
                dsn=settings.database_url,
                min_size=1,
                max_size=5,
                command_timeout=15.0,
                timeout=10.0,
            )
        except Exception as exc:  # noqa: BLE001 - сеть/авторизация/нет пакета
            print(
                f"[api] PostgreSQL недоступна ({settings.masked_dsn}): "
                f"{type(exc).__name__}: {exc}"
            )
        else:
            app.state.pool = pool
            app.state.gateway = AsyncpgGateway(pool)
            print(f"[api] PostgreSQL подключена: {settings.masked_dsn}")
    else:
        print("[api] DATABASE_URL не задан: эндпоинты данных вернут 503 db_unavailable")

    if settings.ready:
        try:
            app.state.llm = OpenRouterLlmClient(settings)
        except Exception as exc:  # noqa: BLE001 - нет пакета openai/битые настройки
            print(f"[api] LLM-клиент не создан: {type(exc).__name__}: {exc}")
        else:
            print(
                f"[api] LLM провайдер {settings.provider} ({settings.base_url}), "
                f"модель {settings.model} / fallback {settings.fallback_model}"
            )
    else:
        print("[api] API-ключ LLM не найден: /ai/classify-preview вернёт 502")


async def _shutdown(app: FastAPI) -> None:
    """Закрывает пул соединений и HTTP-клиент LLM без исключений наружу."""
    pool = getattr(app.state, "pool", None)
    if pool is not None:
        with contextlib.suppress(Exception):
            await pool.close()
        app.state.pool = None
        app.state.gateway = None
    client = getattr(app.state, "llm", None)
    closer = getattr(client, "aclose", None)
    if closer is not None:
        with contextlib.suppress(Exception):
            await closer()
        app.state.llm = None


def create_app(settings: ApiSettings | None = None) -> FastAPI:
    """Собирает ASGI-приложение: CORS, обработчики ошибок, роутер, lifespan."""
    resolved = settings if settings is not None else ApiSettings.from_env()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """Поднимает пул/LLM на старте и закрывает их на остановке."""
        await _startup(app, resolved)
        try:
            yield
        finally:
            await _shutdown(app)

    app = FastAPI(
        title="AI Dev Navigator API",
        description=(
            "REST-слой над PostgreSQL (ai_dev_navigator) и LLM: агрегаты Bento-дашборда, "
            "CRUD по папкам/вакансиям/билетам и AI-классификация со Structured Output. "
            "Контракт: docs/api_spec.md."
        ),
        version=resolved.version,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )
    app.state.settings = resolved
    app.state.gateway = None
    app.state.llm = None
    app.state.pool = None
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        max_age=600,
    )
    app.add_exception_handler(DatabaseUnavailable, _database_unavailable_handler)
    app.add_exception_handler(LlmUnavailable, _llm_unavailable_handler)
    app.include_router(router)
    return app


app = create_app()



