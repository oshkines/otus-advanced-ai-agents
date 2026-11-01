"""Отправка уведомления в корпоративный мессенджер VK Макс (MAX, VK).

Текст берётся из ``sys.argv``. Транспорт выбирается автоматически:

1. ``webhook_url`` из ``config/orchestrator.json`` (``ENV_VK_MAX_URL``) - POST
   конверта проекта (``channel``, ``text``, ``source``, ``sent_at``,
   ``work_hours_only``) на собственный релей или ``tests/mock_webhook.py``;
2. иначе MAX Bot API: ``POST https://platform-api2.max.ru/messages?chat_id=<id>``
   с заголовком ``Authorization: <token>`` и телом ``{"text": "..."}`` - это
   формат ``NewMessageBody`` из официальной спецификации MAX
   (``max-messenger/api-schema``). Реквизиты берутся из ``bot_token``
   (``ENV_VK_MAX_TOKEN``) и ``chat_id`` (``ENV_VK_MAX_CHAT_ID``).

Канал уважает ``work_hours_only``: вне окна 09:00-18:00 МСК сообщение не
отправляется, скрипт завершается кодом 3 (сообщение отложено). Флаг
``--force`` снимает ограничение (ручной запуск дежурным).

Если ни один транспорт не настроен (``ENV_VK_MAX_URL`` пуст, а
``ENV_VK_MAX_TOKEN``/``ENV_VK_MAX_CHAT_ID`` не заданы) или ``webhook_url`` всё
ещё содержит плейсхолдер (``https://<webhook>``, ``CHANGE_ME``,
``example.com``), скрипт печатает понятную ошибку в ``stdout`` и завершается
кодом 2 - сообщение не отправляется. Токен MAX в выводе не появляется.

Запуск (Windows 11, PowerShell):
    .\\.venv\\Scripts\\python.exe agents\\vk_max_sender.py "Сборка ядра упала"
    .\\.venv\\Scripts\\python.exe agents\\vk_max_sender.py --dry-run --force "smoke test"
    .\\.venv\\Scripts\\python.exe agents\\vk_max_sender.py --now 2026-10-26T12:00:00 "alerts to MAX"

Коды выхода: 0 - отправлено или пропущено (``enabled=false``, ``--dry-run``),
             1 - ошибка доставки, 2 - ошибка конфигурации/аргументов,
             3 - вне рабочих часов (сообщение отложено).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

# Скрипт запускается и как agents\vk_max_sender.py, и как модуль agents.vk_max_sender:
# добавляем свой каталог в sys.path, чтобы импорт общего слоя работал в обоих случаях.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from notification_channels import (  # noqa: E402 - импорт после правки sys.path
    DEFAULT_CONFIG,
    EXIT_CONFIG_ERROR,
    EXIT_DELIVERY_FAILED,
    EXIT_OK,
    EXIT_OUTSIDE_WORK_HOURS,
    ChannelConfig,
    ConfigError,
    configure_stdio,
    emit,
    load_channel,
    log,
    mask_url,
    parse_moment,
    placeholder_problem,
    post_json,
)

CHANNEL_NAME: str = "vk_max"
SENDER_ID: str = "agents/vk_max_sender.py"

# MAX Bot API: базовый домен и путь отправки сообщения (OpenAPI max-messenger/api-schema).
MAX_API_ROOT: str = "https://platform-api2.max.ru"
MAX_SEND_PATH: str = "/messages"
# MAX ChatId - 64-битное целое (components.schemas.ChatId), поэтому chat_id проверяем заранее.
CHAT_ID_PATTERN: re.Pattern[str] = re.compile(r"^-?\d{1,19}$")

MODE_WEBHOOK: str = "webhook"
MODE_MAX_API: str = "max_bot_api"


def build_parser() -> argparse.ArgumentParser:
    """Аргументы CLI: текст сообщения и режимы запуска."""
    parser = argparse.ArgumentParser(
        prog="vk_max_sender.py",
        description="Send a notification to VK Max (webhook or MAX Bot API, work hours aware).",
    )
    parser.add_argument("text", nargs="+", help="notification text (parts are joined by spaces)")
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"path to config (default: {DEFAULT_CONFIG})",
    )
    parser.add_argument("--dry-run", action="store_true", help="print payload without network call")
    parser.add_argument("--force", action="store_true", help="send even outside work hours")
    parser.add_argument("--now", default=None, help="ISO-8601 moment for the work-hours check (debug)")
    parser.add_argument("--timeout-sec", type=float, default=None, help="override HTTP timeout")
    return parser


def build_payload(channel: ChannelConfig, text: str, moment: datetime) -> dict[str, Any]:
    """Конверт проекта для POST в собственный вебхук (релей или мок)."""
    return {
        "channel": CHANNEL_NAME,
        "text": text,
        "source": SENDER_ID,
        "sent_at": moment.isoformat(timespec="seconds"),
        "work_hours_only": channel.work_hours_only,
    }


def build_max_payload(text: str) -> dict[str, Any]:
    """Тело ``POST /messages`` для MAX Bot API: ``NewMessageBody`` с полем ``text``.

    Официальная схема (``max-messenger/api-schema``) допускает также
    ``attachments``, ``link``, ``notify`` и ``format``; для алертов достаточно
    ``text`` (до 4000 символов).
    """
    return {"text": text}


def max_api_url(chat_id: str) -> str:
    """URL отправки сообщения: ``chat_id`` передаётся query-параметром (ChatId = int64)."""
    return f"{MAX_API_ROOT}{MAX_SEND_PATH}?chat_id={urllib.parse.quote(chat_id, safe='')}"


def resolve_transport(
    channel: ChannelConfig, text: str, moment: datetime
) -> tuple[str, str, dict[str, Any], dict[str, str]]:
    """Возвращает ``(режим, URL, payload, заголовки)``; вебхук приоритетнее Bot API.

    :raises ConfigError: не настроен ни один транспорт или ``chat_id`` не является
        целым числом (MAX ChatId - int64).
    """
    if channel.webhook_url:
        return MODE_WEBHOOK, channel.webhook_url, build_payload(channel, text, moment), {}
    if channel.bot_token and channel.chat_id:
        if not CHAT_ID_PATTERN.match(channel.chat_id):
            raise ConfigError(
                "notification_channels.vk_max.chat_id must be an int64 (MAX ChatId), "
                f"got {channel.chat_id!r}"
            )
        return (
            MODE_MAX_API,
            max_api_url(channel.chat_id),
            build_max_payload(text),
            {"Authorization": channel.bot_token},
        )
    raise ConfigError(
        "no transport configured: set webhook_url "
        f"({channel.webhook_source or 'ENV_VK_MAX_URL'}) or bot_token + chat_id "
        "(ENV_VK_MAX_TOKEN + ENV_VK_MAX_CHAT_ID)"
    )


def run(args: argparse.Namespace) -> int:
    """Выполняет сценарий отправки и возвращает код выхода."""
    text = " ".join(args.text).strip()
    if not text:
        emit({"status": "failed", "reason": "empty_text", "channel": CHANNEL_NAME, "sender": SENDER_ID})
        log("ERROR: notification text is empty")
        return EXIT_CONFIG_ERROR

    channel = load_channel(CHANNEL_NAME, args.config)
    moment = parse_moment(args.now)
    context: dict[str, Any] = {
        "channel": CHANNEL_NAME,
        "sender": SENDER_ID,
        "moscow_time": moment.isoformat(timespec="seconds"),
        "text_length": len(text),
    }
    log(
        f"channel={CHANNEL_NAME} enabled={channel.enabled} "
        f"work_hours_only={channel.work_hours_only} webhook={channel.webhook_configured} "
        f"max_api={bool(channel.bot_token and channel.chat_id)} msk={moment:%Y-%m-%d %H:%M}"
    )

    if not channel.enabled:
        emit({**context, "status": "skipped", "reason": "channel_disabled"})
        log("SKIP: channel is disabled in config")
        return EXIT_OK

    # Проверка webhook_url идёт до окна рабочих часов: битый конфиг важнее
    # отложенной доставки, иначе сообщение потеряется молча. Незаданный
    # ENV_VK_MAX_URL - не ошибка, если настроен MAX Bot API (токен + chat_id).
    has_max_api = bool(channel.bot_token and channel.chat_id)
    problem = placeholder_problem(
        channel.webhook_url,
        env_name=channel.webhook_source,
        missing_env_is_error=not has_max_api,
    )
    if problem is not None:
        # Понятная ошибка - в stdout (JSON), диагностика дублируется в stderr.
        emit(
            {
                **context,
                "status": "failed",
                "reason": "webhook_placeholder",
                "webhook_source": channel.webhook_source or "<empty>",
                "error": problem,
            }
        )
        log(f"CONFIG ERROR: {problem}")
        return EXIT_CONFIG_ERROR

    if channel.blocks_now(moment) and not args.force:
        emit(
            {
                **context,
                "status": "deferred",
                "reason": "outside_work_hours",
                "work_hours": channel.work_hours_label(),
            }
        )
        log(f"DEFER: outside work hours ({channel.work_hours_label()}), use --force to override")
        return EXIT_OUTSIDE_WORK_HOURS

    mode, url, payload, headers = resolve_transport(channel, text, moment)
    target = mask_url(url)
    context["delivery_mode"] = mode

    if args.dry_run:
        emit({**context, "status": "dry_run", "target": target, "payload": payload})
        log(f"DRY-RUN: mode={mode} POST {target} payload={json.dumps(payload, ensure_ascii=True)}")
        return EXIT_OK

    timeout_sec = args.timeout_sec if args.timeout_sec is not None else channel.timeout_sec
    try:
        http_status, response_preview = post_json(url, payload, timeout_sec=timeout_sec, headers=headers)
    except (OSError, ValueError) as exc:  # urllib.error.URLError наследуется от OSError
        emit({**context, "status": "failed", "reason": "transport_error", "error": str(exc), "target": target})
        log(f"FAIL: transport error: {exc}")
        return EXIT_DELIVERY_FAILED

    if 200 <= http_status < 300:
        emit(
            {
                **context,
                "status": "sent",
                "http_status": http_status,
                "target": target,
                "response_preview": response_preview,
            }
        )
        log(f"OK: delivered to VK Max ({mode}), http={http_status}")
        return EXIT_OK

    emit(
        {
            **context,
            "status": "failed",
            "reason": "http_error",
            "http_status": http_status,
            "target": target,
            "response_preview": response_preview,
        }
    )
    log(f"FAIL: VK Max ({mode}) returned http={http_status}")
    return EXIT_DELIVERY_FAILED


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
                "sender": SENDER_ID,
                "error": str(exc),
            }
        )
        log(f"CONFIG ERROR: {exc}")
        return EXIT_CONFIG_ERROR


if __name__ == "__main__":
    sys.exit(main())

