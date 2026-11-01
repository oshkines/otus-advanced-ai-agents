"""Диагностика канала MAX (VK Макс): проверка токена и получение ``chat_id``.

Скрипт закрывает шаг настройки, который нельзя пройти «вслепую»: для отправки
нужен ``chat_id`` (``ChatId`` = int64), а его знает только платформа MAX.
Диагностика делает до двух GET-запросов к MAX Bot API:

1. ``GET https://platform-api2.max.ru/me`` - проверка токена
   (``Authorization: <access_token>``) и сведения о боте;
2. ``GET https://platform-api2.max.ru/updates?limit=...&timeout=0`` - последние
   обновления (long polling); из них собираются уникальные ``chat_id`` чатов и
   каналов, куда добавлен бот. ``chat_id`` берётся из поля ``Update.chat_id``,
   а при его отсутствии - из ``Update.message.recipient.chat_id``.

Документация: ``dev.max.ru/docs-api`` (``GET /me``, ``GET /updates``, объект
``Update``). ``GET /updates`` предназначен для разработки и тестирования; в
штатной работе канал только отправляет сообщения (``agents/vk_max_sender.py``).

Секреты: токен читается из ``bot_token`` канала (``ENV_VK_MAX_TOKEN``) и не
попадает ни в ``stdout``, ни в ``stderr``. ``chat_id``, наоборот, печатается
открыто - без него невозможно заполнить ``ENV_VK_MAX_CHAT_ID``; в sender-скриптах
значение по-прежнему маскируется как ``chat_id=***``.

Запуск (Windows 11, PowerShell):
    $env:ENV_VK_MAX_TOKEN = "<max-bot-token>"
    .\\.venv\\Scripts\\python.exe agents\\max_probe.py            # только проверка токена
    .\\.venv\\Scripts\\python.exe agents\\max_probe.py --chats    # + список chat_id
    .\\.venv\\Scripts\\python.exe agents\\max_probe.py --dry-run --chats

Коды выхода: 0 - диагностика прошла, 1 - ошибка HTTP/сети или битый ответ,
             2 - ошибка конфигурации (нет токена, битый ``config/orchestrator.json``).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Mapping, Sequence

# Скрипт запускается и как agents\max_probe.py, и как модуль agents.max_probe:
# добавляем свой каталог в sys.path, чтобы импорт общего слоя работал в обоих случаях.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from notification_channels import (  # noqa: E402 - импорт после правки sys.path
    DEFAULT_CONFIG,
    EXIT_CONFIG_ERROR,
    EXIT_DELIVERY_FAILED,
    EXIT_OK,
    ConfigError,
    configure_stdio,
    emit,
    get_json,
    load_channel,
    log,
    mask_url,
)
from vk_max_sender import (  # noqa: E402 - общие константы канала и домен MAX
    CHANNEL_NAME,
    CHAT_ID_PATTERN,
    MAX_API_ROOT,
)

PROBE_ID: str = "agents/max_probe.py"
MAX_ME_PATH: str = "/me"
MAX_UPDATES_PATH: str = "/updates"
# Диапазоны из спецификации MAX: limit [1-1000], timeout long polling [0-90] секунд.
DEFAULT_UPDATES_LIMIT: int = 100
MIN_UPDATES_LIMIT: int = 1
MAX_UPDATES_LIMIT: int = 1000
MIN_POLL_TIMEOUT: int = 0
MAX_POLL_TIMEOUT: int = 90
# Длина превью тела ответа в JSON-событии (полный ответ в stdout не нужен).
PREVIEW_CHARS: int = 200


def bounded_int(minimum: int, maximum: int, name: str) -> Any:
    """Фабрика ``type=`` для argparse: целое в диапазоне ``[minimum, maximum]``."""

    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"{name} must be an integer, got {value!r}") from exc
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(f"{name} must be in [{minimum}, {maximum}], got {number}")
        return number

    return parse


def me_url() -> str:
    """URL проверки токена: ``GET /me``."""
    return f"{MAX_API_ROOT}{MAX_ME_PATH}"


def updates_url(limit: int, poll_timeout: int) -> str:
    """URL получения обновлений: ``GET /updates?limit=...&timeout=...``."""
    query = urllib.parse.urlencode({"limit": limit, "timeout": poll_timeout})
    return f"{MAX_API_ROOT}{MAX_UPDATES_PATH}?{query}"


def preview(body: str) -> str:
    """Начало тела ответа для поля ``response_preview``."""
    return (body or "")[:PREVIEW_CHARS]


def parse_bot_info(body: str) -> dict[str, Any]:
    """Достаёт из ответа ``GET /me`` сведения о боте.

    :raises ValueError: тело не является JSON-объектом.
    """
    try:
        document = json.loads(body)
    except ValueError as exc:
        raise ValueError(f"GET /me: response is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError("GET /me: response is not a JSON object")
    return {
        "user_id": document.get("user_id"),
        "name": document.get("name"),
        "username": document.get("username"),
        "is_bot": document.get("is_bot"),
    }


def parse_updates(body: str) -> list[Mapping[str, Any]]:
    """Достаёт массив ``Update`` из ответа ``GET /updates`` (``{"updates": [...]}`` ).

    Пустой или отсутствующий массив - не ошибка: бот мог быть только что
    создан и ещё не добавлен ни в один чат.

    :raises ValueError: тело не JSON-объект или ``updates`` не массив.
    """
    try:
        document = json.loads(body)
    except ValueError as exc:
        raise ValueError(f"GET /updates: response is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError("GET /updates: response is not a JSON object")
    raw = document.get("updates")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("GET /updates: 'updates' field is not an array")
    return [item for item in raw if isinstance(item, dict)]


def extract_chat_id(update: Mapping[str, Any]) -> int | None:
    """Ищет ``chat_id``: верхнее поле ``Update.chat_id`` или ``message.recipient.chat_id``."""
    raw = update.get("chat_id")
    if raw is None:
        message = update.get("message")
        recipient = message.get("recipient") if isinstance(message, dict) else None
        raw = recipient.get("chat_id") if isinstance(recipient, dict) else None
    if isinstance(raw, bool):  # bool - подкласс int, отсекаем явно
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str) and CHAT_ID_PATTERN.match(raw.strip()):
        return int(raw.strip())
    return None


def extract_chat_type(update: Mapping[str, Any]) -> str | None:
    """Тип чата: ``message.recipient.chat_type`` либо ``channel`` по флагу ``is_channel``."""
    message = update.get("message")
    recipient = message.get("recipient") if isinstance(message, dict) else None
    chat_type = recipient.get("chat_type") if isinstance(recipient, dict) else None
    if isinstance(chat_type, str) and chat_type:
        return chat_type
    if update.get("is_channel") is True:
        return "channel"
    return None


def collect_chats(updates: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Собирает уникальные ``chat_id`` из обновлений (по возрастанию ID).

    Для каждого чата фиксируются встреченные ``update_type`` и тип чата: так
    видно, откуда взялся ID (``bot_added``, ``message_created``, ``bot_started``).
    """
    found: dict[int, dict[str, Any]] = {}
    for update in updates:
        chat_id = extract_chat_id(update)
        if chat_id is None:
            continue
        entry = found.setdefault(chat_id, {"chat_id": chat_id, "update_types": [], "chat_type": None})
        update_type = update.get("update_type")
        if isinstance(update_type, str) and update_type not in entry["update_types"]:
            entry["update_types"].append(update_type)
        chat_type = extract_chat_type(update)
        if chat_type and not entry["chat_type"]:
            entry["chat_type"] = chat_type
    return [
        {**entry, "update_types": sorted(entry["update_types"])}
        for _, entry in sorted(found.items(), key=lambda pair: pair[0])
    ]


def build_parser() -> argparse.ArgumentParser:
    """Аргументы CLI: что именно проверять и с какими таймаутами."""
    parser = argparse.ArgumentParser(
        prog="max_probe.py",
        description="Check the MAX (VK Max) bot token and list chat ids via MAX Bot API.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"path to config (default: {DEFAULT_CONFIG})",
    )
    parser.add_argument(
        "--chats",
        action="store_true",
        help="also call GET /updates and print unique chat ids (for ENV_VK_MAX_CHAT_ID)",
    )
    parser.add_argument(
        "--limit",
        type=bounded_int(MIN_UPDATES_LIMIT, MAX_UPDATES_LIMIT, "limit"),
        default=DEFAULT_UPDATES_LIMIT,
        help=f"updates per request, {MIN_UPDATES_LIMIT}-{MAX_UPDATES_LIMIT} (default: {DEFAULT_UPDATES_LIMIT})",
    )
    parser.add_argument(
        "--updates-timeout",
        type=bounded_int(MIN_POLL_TIMEOUT, MAX_POLL_TIMEOUT, "updates-timeout"),
        default=MIN_POLL_TIMEOUT,
        help=f"long polling timeout in seconds, {MIN_POLL_TIMEOUT}-{MAX_POLL_TIMEOUT} (default: 0 - answer at once)",
    )
    parser.add_argument("--dry-run", action="store_true", help="print request targets without network call")
    parser.add_argument("--timeout-sec", type=float, default=None, help="override HTTP timeout")
    return parser


def request_bot(
    headers: Mapping[str, str], timeout_sec: float, context: Mapping[str, Any]
) -> tuple[dict[str, Any], int]:
    """``GET /me``: проверка токена. Возвращает ``(событие, код выхода)``.

    При ошибке событие уже отправлено в ``stdout``, а словарь пуст - вызывающему
    остаётся только вернуть код.
    """
    target = me_url()
    try:
        http_status, body = get_json(target, timeout_sec=timeout_sec, headers=headers)
    except (OSError, ValueError) as exc:  # urllib.error.URLError наследуется от OSError
        emit({**context, "status": "failed", "reason": "transport_error", "error": str(exc), "target": target})
        log(f"FAIL: GET /me transport error: {exc}")
        return {}, EXIT_DELIVERY_FAILED

    if not 200 <= http_status < 300:
        reason = "unauthorized" if http_status in (401, 403) else "http_error"
        emit(
            {
                **context,
                "status": "failed",
                "reason": reason,
                "http_status": http_status,
                "target": target,
                "response_preview": preview(body),
            }
        )
        log(f"FAIL: GET /me returned http={http_status} ({reason})")
        return {}, EXIT_DELIVERY_FAILED

    try:
        bot = parse_bot_info(body)
    except ValueError as exc:
        emit(
            {
                **context,
                "status": "failed",
                "reason": "invalid_response",
                "error": str(exc),
                "target": target,
                "response_preview": preview(body),
            }
        )
        log(f"FAIL: {exc}")
        return {}, EXIT_DELIVERY_FAILED

    return {"bot": bot, "http_status": http_status}, EXIT_OK


def request_chats(
    base: Mapping[str, Any],
    headers: Mapping[str, str],
    timeout_sec: float,
    args: argparse.Namespace,
) -> tuple[dict[str, Any], int]:
    """``GET /updates``: собирает ``chat_id`` для ``ENV_VK_MAX_CHAT_ID``.

    Возвращает ``(событие, код выхода)``; при ошибке событие уже отправлено.
    """
    target = updates_url(args.limit, args.updates_timeout)
    try:
        http_status, body = get_json(target, timeout_sec=timeout_sec, headers=headers)
    except (OSError, ValueError) as exc:
        emit({**base, "status": "failed", "reason": "transport_error", "error": str(exc), "target": target})
        log(f"FAIL: GET /updates transport error: {exc}")
        return {}, EXIT_DELIVERY_FAILED

    if not 200 <= http_status < 300:
        reason = "unauthorized" if http_status in (401, 403) else "http_error"
        emit(
            {
                **base,
                "status": "failed",
                "reason": reason,
                "http_status": http_status,
                "target": target,
                "response_preview": preview(body),
            }
        )
        log(f"FAIL: GET /updates returned http={http_status} ({reason})")
        return {}, EXIT_DELIVERY_FAILED

    try:
        updates = parse_updates(body)
    except ValueError as exc:
        emit(
            {
                **base,
                "status": "failed",
                "reason": "invalid_response",
                "error": str(exc),
                "target": target,
                "response_preview": preview(body),
            }
        )
        log(f"FAIL: {exc}")
        return {}, EXIT_DELIVERY_FAILED

    chats = collect_chats(updates)
    event: dict[str, Any] = {**base, "chats": chats, "updates_seen": len(updates)}
    if chats:
        event["next_step"] = (
            "set ENV_VK_MAX_CHAT_ID to one of the chat_id values and run agents/vk_max_sender.py"
        )
        log(f"OK: chat ids found: {[chat['chat_id'] for chat in chats]}")
    else:
        event["hint"] = (
            "no chats yet: add the bot to a chat or channel, write any message there, then rerun with --chats"
        )
        log("OK: token is valid, but no chats found in GET /updates")
    return event, EXIT_OK


def run(args: argparse.Namespace) -> int:
    """Выполняет диагностику и возвращает код выхода."""
    channel = load_channel(CHANNEL_NAME, args.config)
    context: dict[str, Any] = {"channel": CHANNEL_NAME, "probe": PROBE_ID}

    if not channel.bot_token:
        error = (
            "bot_token is not set: point notification_channels.vk_max.bot_token at an "
            "environment variable name (default ENV_VK_MAX_TOKEN) and export the token"
        )
        emit({**context, "status": "failed", "reason": "token_missing", "error": error})
        log(f"CONFIG ERROR: {error}")
        return EXIT_CONFIG_ERROR

    if not channel.enabled:
        log("WARN: channel is disabled in config; sending is skipped, diagnostics still runs")

    headers = {"Authorization": channel.bot_token}
    timeout_sec = args.timeout_sec if args.timeout_sec is not None else channel.timeout_sec
    targets = [me_url()] + ([updates_url(args.limit, args.updates_timeout)] if args.chats else [])
    log(f"probe: token=set chats={bool(args.chats)} timeout={timeout_sec:g}s")

    if args.dry_run:
        masked = [mask_url(target) for target in targets]
        emit({**context, "status": "dry_run", "targets": masked})
        log(f"DRY-RUN: GET {' GET '.join(masked)}")
        return EXIT_OK

    me_result, me_code = request_bot(headers, timeout_sec, context)
    if me_code != EXIT_OK:
        return me_code

    base: dict[str, Any] = {
        **context,
        "status": "ok",
        "http_status": me_result["http_status"],
        "bot": me_result["bot"],
    }
    if not args.chats:
        emit(base)
        log("OK: token is valid (GET /me); use --chats to list chat ids")
        return EXIT_OK

    chats_event, chats_code = request_chats(base, headers, timeout_sec, args)
    if chats_code != EXIT_OK:
        return chats_code
    emit(chats_event)
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    """Точка входа CLI."""
    configure_stdio()
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except ConfigError as exc:
        emit(
            {
                "status": "failed",
                "reason": "config_error",
                "channel": CHANNEL_NAME,
                "probe": PROBE_ID,
                "error": str(exc),
            }
        )
        log(f"CONFIG ERROR: {exc}")
        return EXIT_CONFIG_ERROR


if __name__ == "__main__":
    sys.exit(main())

