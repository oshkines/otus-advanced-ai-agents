"""Общие примитивы доставки уведомлений для воркеров AI Dev Orchestrator.

Модуль читает блок ``notification_channels`` из ``config/orchestrator.json``,
разворачивает имена переменных окружения (значения вида ``ENV_*``) и выполняет
HTTP POST. Используется скриптами ``agents/vk_max_sender.py`` и
``agents/telegram_sender.py``.

Правила проекта (``.clinerules``, ``CLAUDE.md``, ``.planning/SECURITY.md``):
  * файл ``.env`` не читается - секреты берутся только из окружения Windows;
  * токены и секретные части URL никогда не печатаются (см. :func:`mask_url`);
  * в ``stdout`` уходит одна строка JSON, диагностика - в ``stderr``.

HTTP-слой: если в окружении установлен ``requests``, используется он, иначе -
``urllib.request`` из стандартной библиотеки (проект остаётся работоспособным
без дополнительных зависимостей).
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG: Path = PROJECT_ROOT / "config" / "orchestrator.json"
USER_AGENT: str = "ai-dev-orchestrator/0.2"
# Верхняя граница читаемого тела ответа: защита от гигантского JSON в GET /updates.
MAX_RESPONSE_BYTES: int = 1_048_576

# Москва: UTC+3 круглый год (перехода на летнее время нет с 2014 года).
# Фиксированное смещение - резерв, если в системе отсутствует база tzdata.
MSK_FALLBACK: timezone = timezone(timedelta(hours=3), name="MSK")

# Коды выхода, общие для всех sender-скриптов.
EXIT_OK: int = 0
EXIT_DELIVERY_FAILED: int = 1
EXIT_CONFIG_ERROR: int = 2
EXIT_OUTSIDE_WORK_HOURS: int = 3


class ConfigError(RuntimeError):
    """Ошибка чтения или валидации ``config/orchestrator.json``."""


def log(message: str) -> None:
    """Пишет диагностику в ``stderr`` с временной меткой (требование CLAUDE.md).

    Текст намеренно ASCII-only: консоли Windows в cp866/cp1251 иначе показывают
    кириллицу как мусор. Пользовательский текст в логи не попадает.
    """
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}", file=sys.stderr, flush=True)


def emit(event: Mapping[str, Any]) -> None:
    """Пишет одну JSON-строку результата в ``stdout`` (контракт «ядро ↔ воркер»)."""
    payload: dict[str, Any] = dict(event)
    payload.setdefault("timestamp", datetime.now(tz=MSK_FALLBACK).isoformat(timespec="seconds"))
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def configure_stdio() -> None:
    """Переводит ``stdout``/``stderr`` в UTF-8, чтобы JSON не зависел от кодовой страницы."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # поток уже закрыт или перенаправлен экзотически
                pass


def moscow_now() -> datetime:
    """Текущий момент времени в Москве (Europe/Moscow)."""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(tz=ZoneInfo("Europe/Moscow"))
    except Exception:  # ZoneInfoNotFoundError (нет tzdata) и прочие сбои tzdb
        return datetime.now(tz=MSK_FALLBACK)


def parse_moment(value: str | None) -> datetime:
    """Возвращает момент времени в МСК: из ISO-8601 (``--now``) или текущий."""
    if not value:
        return moscow_now()
    try:
        moment = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ConfigError(f"invalid ISO-8601 moment: {value!r}") from exc
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=MSK_FALLBACK)
    return moment.astimezone(MSK_FALLBACK)


def parse_hh_mm(value: str) -> time:
    """Разбирает строку ``HH:MM`` в :class:`datetime.time`; иначе ``ConfigError``."""
    parts = value.strip().split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise ConfigError(f"invalid time value {value!r}, expected HH:MM")
    hours, minutes = int(parts[0]), int(parts[1])
    if not (0 <= hours <= 23 and 0 <= minutes <= 59):
        raise ConfigError(f"time value out of range: {value!r}")
    return time(hour=hours, minute=minutes)


def within_work_hours(start: time, end: time, moment: datetime) -> bool:
    """Проверяет попадание момента в окно ``[start, end)`` по локальному времени.

    Поддерживает окна через полночь (например, ``22:00-06:00``); ``start == end``
    трактуется как «круглые сутки».
    """
    current = moment.time().replace(second=0, microsecond=0)
    if start == end:
        return True
    if start < end:
        return start <= current < end
    return current >= start or current < end


def resolve_env(value: str | None, env: Mapping[str, str] | None = None) -> str:
    """Разворачивает значение конфига: ``ENV_NAME`` -> ``os.environ["ENV_NAME"]``.

    Литеральные значения (например, ``https://...``) возвращаются как есть.
    """
    if not value:
        return ""
    text = str(value).strip()
    if not text.startswith("ENV_"):
        return text
    source = os.environ if env is None else env
    return source.get(text, "").strip()


# Признаки незаполненного плейсхолдера: шаблон конфига так и не заменили реальным URL.
PLACEHOLDER_MARKERS: tuple[str, ...] = (
    "<",
    ">",
    "example.com",
    "example.org",
    "changeme",
    "change_me",
    "your-",
    "your_",
    "placeholder",
)


def placeholder_problem(
    url: str | None, *, env_name: str = "", missing_env_is_error: bool = True
) -> str | None:
    """Возвращает человекочитаемую причину, если ``url`` — незаполненный плейсхолдер.

    Проверяются: пустое значение, неразвёрнутое имя переменной окружения
    (строка ``ENV_VK_MAX_URL`` осталась в конфиге), угловые скобки
    (``https://<webhook>``), не-HTTP схема и типовые заглушки (``CHANGE_ME``,
    ``example.com``).

    :param missing_env_is_error: ``False`` позволяет трактовать незаданную
        переменную окружения как «URL не настроен» (``None``) - так telegram
        переключается на Bot API; литеральные плейсхолдеры остаются ошибкой.
    :returns: текст ошибки для ``stdout`` или ``None``, если URL пригоден для POST.
    """
    text = (url or "").strip()
    if not text:
        if env_name:
            missing = f"webhook_url is not set: environment variable {env_name} is empty or missing"
        else:
            missing = "webhook_url is not set in config/orchestrator.json"
        return missing if missing_env_is_error else None
    if text.startswith("ENV_"):
        missing = f"webhook_url is not resolved: environment variable {text} is empty or missing"
        return missing if missing_env_is_error else None
    lowered = text.lower()
    if not lowered.startswith(("http://", "https://")):
        return f"webhook_url must start with http:// or https://, got {text!r}"
    for marker in PLACEHOLDER_MARKERS:
        if marker in lowered:
            return f"webhook_url still contains a placeholder ({marker!r}): {text!r}"
    return None


def mask_url(url: str | None) -> str:
    """Скрывает секреты в URL: query-параметры и токен Telegram Bot API."""
    if not url:
        return ""
    parts = urllib.parse.urlsplit(url)
    path = parts.path
    marker = "/bot"
    if marker in path:
        head, _, tail = path.partition(marker)
        token, separator, rest = tail.partition("/")
        if token:
            path = f"{head}{marker}***{separator}{rest}"
    query = "&".join(f"{pair.split('=', 1)[0]}=***" for pair in parts.query.split("&") if pair)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, ""))


@dataclass(frozen=True, slots=True)
class ChannelConfig:
    """Нормализованный блок ``notification_channels.<name>`` из конфига."""

    name: str
    enabled: bool
    webhook_source: str
    webhook_url: str
    bot_token: str
    chat_id: str
    sender_script: str
    timeout_sec: float
    work_hours_only: bool
    work_start: time
    work_end: time
    timezone_name: str

    @property
    def webhook_configured(self) -> bool:
        """True, если ``webhook_url`` задан и развёрнут из окружения."""
        return bool(self.webhook_url)

    def work_hours_label(self) -> str:
        """Человекочитаемое окно, например ``09:00-18:00 Europe/Moscow``."""
        return f"{self.work_start:%H:%M}-{self.work_end:%H:%M} {self.timezone_name}"

    def blocks_now(self, moment: datetime) -> bool:
        """True, если канал ограничен рабочими часами и момент вне окна."""
        if not self.work_hours_only:
            return False
        return not within_work_hours(self.work_start, self.work_end, moment)


def load_channel(name: str, config_path: Path = DEFAULT_CONFIG) -> ChannelConfig:
    """Читает и валидирует один канал из ``config/orchestrator.json``.

    :raises ConfigError: файл отсутствует, JSON битый, нет нужного блока,
        некорректны ``work_hours_only`` или ``timeout_sec``.
    """
    config_path = Path(config_path)
    if not config_path.is_file():
        raise ConfigError(f"config file not found: {config_path}")
    try:
        document: Any = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"cannot read {config_path}: {exc}") from exc

    channels = document.get("notification_channels") if isinstance(document, dict) else None
    if not isinstance(channels, dict):
        raise ConfigError("config has no 'notification_channels' object")
    block = channels.get(name)
    if not isinstance(block, dict):
        raise ConfigError(f"config has no notification_channels.{name} object")

    raw_hours = block.get("work_hours_only")
    work_hours_only = False
    hours: Mapping[str, Any] = {}
    if isinstance(raw_hours, bool):
        work_hours_only = raw_hours
    elif isinstance(raw_hours, dict):
        hours = raw_hours
        work_hours_only = bool(hours.get("enabled", True))
    elif raw_hours is not None:
        raise ConfigError(f"notification_channels.{name}.work_hours_only must be an object or boolean")

    try:
        timeout_sec = float(block.get("timeout_sec", 15))
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"notification_channels.{name}.timeout_sec must be a number") from exc
    if timeout_sec <= 0:
        raise ConfigError(f"notification_channels.{name}.timeout_sec must be positive")

    return ChannelConfig(
        name=name,
        enabled=bool(block.get("enabled", False)),
        webhook_source=str(block.get("webhook_url", "")),
        webhook_url=resolve_env(block.get("webhook_url")),
        bot_token=resolve_env(block.get("bot_token")),
        chat_id=resolve_env(block.get("chat_id")),
        sender_script=str(block.get("sender_script", "")),
        timeout_sec=timeout_sec,
        work_hours_only=work_hours_only,
        work_start=parse_hh_mm(str(hours.get("start", "09:00"))),
        work_end=parse_hh_mm(str(hours.get("end", "18:00"))),
        timezone_name=str(hours.get("timezone", "Europe/Moscow")),
    )


def post_json(
    url: str,
    payload: Mapping[str, Any],
    *,
    timeout_sec: float,
    headers: Mapping[str, str] | None = None,
) -> tuple[int, str]:
    """Отправляет JSON POST-запрос и возвращает ``(HTTP-статус, начало ответа)``.

    ``requests`` используется, если установлен; иначе - stdlib ``urllib``.
    Сетевые ошибки не подавляются: их обрабатывает вызывающий скрипт.

    :param headers: дополнительные заголовки (например, ``Authorization`` для
        MAX Bot API). Значения заголовков - секреты, они никогда не логируются
        и не попадают в ``stdout``.
    """
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request_headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if headers:
        request_headers.update({str(name): str(value) for name, value in headers.items()})

    requests_module = _import_requests()
    if requests_module is not None:
        response = requests_module.post(url, data=body, headers=request_headers, timeout=timeout_sec)
        return int(response.status_code), str(response.text)[:500]

    request = urllib.request.Request(url, data=body, headers=request_headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            return int(response.status), response.read(500).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # 4xx/5xx тоже нужно вернуть как статус
        return int(exc.code), exc.read(500).decode("utf-8", "replace")


def get_json(
    url: str,
    *,
    timeout_sec: float,
    headers: Mapping[str, str] | None = None,
) -> tuple[int, str]:
    """Выполняет GET-запрос и возвращает ``(HTTP-статус, тело ответа)``.

    Нужен диагностике MAX (``agents/max_probe.py``): ``GET /me`` и ``GET /updates``.
    Заголовки и обработка ошибок - как у :func:`post_json`: значения ``headers``
    являются секретами и никогда не логируются, HTTP 4xx/5xx возвращаются как
    статус, а не как исключение.

    :param headers: дополнительные заголовки (например, ``Authorization`` для
        MAX Bot API).
    """
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if headers:
        request_headers.update({str(name): str(value) for name, value in headers.items()})

    requests_module = _import_requests()
    if requests_module is not None:
        response = requests_module.get(url, headers=request_headers, timeout=timeout_sec)
        return int(response.status_code), str(response.text)[:MAX_RESPONSE_BYTES]

    request = urllib.request.Request(url, headers=request_headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            return int(response.status), response.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # 4xx/5xx тоже нужно вернуть как статус
        return int(exc.code), exc.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")


def _import_requests() -> Any:
    """Возвращает модуль ``requests`` или ``None``, если он не установлен."""
    try:
        import requests  # noqa: PLC0415 - опциональная зависимость, импорт по требованию
    except ImportError:
        return None
    return requests

