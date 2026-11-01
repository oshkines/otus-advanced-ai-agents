"""Круглосуточная отправка алертов в Telegram.

Текст берётся из ``sys.argv``. Транспорт выбирается автоматически:
  1. ``webhook_url`` (``ENV_TELEGRAM_WEBHOOK_URL``) - прямой POST в вебхук;
  2. иначе Telegram Bot API: ``https://api.telegram.org/bot<token>/sendMessage``
     с ``bot_token`` (``ENV_TELEGRAM_BOT_TOKEN``) и ``chat_id`` (``ENV_TELEGRAM_CHAT_ID``).

Канал аварийный, поэтому ограничение ``work_hours_only`` для него отключено в
конфиге и скриптом игнорируется: алерты уходят 24/7. Если в конфиге окно всё
же включат, скрипт только предупредит в ``stderr`` (``work_hours_ignored``).

Секреты читаются только из ``os.environ`` (``bot_token``/``chat_id`` ->
``ENV_TELEGRAM_BOT_TOKEN``/``ENV_TELEGRAM_CHAT_ID``), в конфиге хранятся лишь
имена переменных. HTTP-транспорт - ``requests``; если пакет недоступен,
используется ``urllib`` из стандартной библиотеки.

Запуск (Windows 11, PowerShell):
    .\\.venv\\Scripts\\python.exe agents\\telegram_sender.py "Ядро остановлено"
    .\\.venv\\Scripts\\python.exe agents\\telegram_sender.py --dry-run "smoke test"

Коды выхода: 0 - отправлено/пропущено/``--dry-run``, 1 - ошибка доставки,
             2 - ошибка конфигурации или аргументов.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

# Скрипт запускается и как agents\telegram_sender.py, и как модуль agents.telegram_sender.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from notification_channels import (  # noqa: E402 - импорт после правки sys.path
    DEFAULT_CONFIG,
    EXIT_CONFIG_ERROR,
    EXIT_DELIVERY_FAILED,
    EXIT_OK,
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

CHANNEL_NAME: str = "telegram"
SENDER_ID: str = "agents/telegram_sender.py"
TELEGRAM_API_ROOT: str = "https://api.telegram.org"


def build_parser() -> argparse.ArgumentParser:
    """Аргументы CLI: текст сообщения и режимы запуска."""
    parser = argparse.ArgumentParser(
        prog="telegram_sender.py",
        description="Send an alert to Telegram 24/7 (webhook or Bot API).",
    )
    parser.add_argument("text", nargs="+", help="notification text (parts are joined by spaces)")
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help=f"path to config (default: {DEFAULT_CONFIG})",
    )
    parser.add_argument("--dry-run", action="store_true", help="print payload without network call")
    parser.add_argument("--now", default=None, help="ISO-8601 moment for the payload timestamp (debug)")
    parser.add_argument("--timeout-sec", type=float, default=None, help="override HTTP timeout")
    return parser


def resolve_transport(channel: ChannelConfig, text: str, moment: datetime) -> tuple[str, str, dict[str, Any]]:
    """Возвращает ``(режим, URL, payload)``: вебхук приоритетнее Bot API.

    Незаданная переменная окружения вебхука - штатный переход на Bot API, а вот
    литеральный плейсхолдер в конфиге (``https://<webhook>``, ``example.com``)
    считается ошибкой конфигурации.

    :raises ConfigError: вместо URL остался плейсхолдер или не задан ни один транспорт.
    """
    problem: str | None = None
    if channel.webhook_source:
        problem = placeholder_problem(
            channel.webhook_url, env_name=channel.webhook_source, missing_env_is_error=False
        )
        if problem is not None:
            raise ConfigError(f"telegram: {problem}")
    if channel.webhook_configured:
        payload: dict[str, Any] = {
            "channel": CHANNEL_NAME,
            "text": text,
            "source": SENDER_ID,
            "sent_at": moment.isoformat(timespec="seconds"),
            "priority": "alert",
        }
        return "webhook", channel.webhook_url, payload
    if channel.bot_token and channel.chat_id:
        url = f"{TELEGRAM_API_ROOT}/bot{channel.bot_token}/sendMessage"
        payload = {
            "chat_id": channel.chat_id,
            "text": text,
            "disable_web_page_preview": True,
            "disable_notification": False,
        }
        return "bot_api", url, payload
    raise ConfigError(
        "telegram: neither webhook_url nor bot_token/chat_id are configured "
        "(ENV_TELEGRAM_WEBHOOK_URL / ENV_TELEGRAM_BOT_TOKEN / ENV_TELEGRAM_CHAT_ID)"
    )


def run(args: argparse.Namespace) -> int:
    """Выполняет сценарий отправки алерта и возвращает код выхода."""
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
        "delivery_window": "24/7",
    }
    log(
        f"channel={CHANNEL_NAME} enabled={channel.enabled} "
        f"webhook={channel.webhook_configured} msk={moment:%Y-%m-%d %H:%M}"
    )

    if not channel.enabled:
        emit({**context, "status": "skipped", "reason": "channel_disabled"})
        log("SKIP: channel is disabled in config")
        return EXIT_OK

    if channel.work_hours_only:
        # Алерты не откладываются: ограничение рабочих часов к этому каналу не применяется.
        context["work_hours_ignored"] = True
        log(
            "WARN: work_hours_only is enabled in config for telegram "
            f"({channel.work_hours_label()}) but ignored: alerts are sent 24/7"
        )

    mode, url, payload = resolve_transport(channel, text, moment)
    target = mask_url(url)
    context["delivery_mode"] = mode

    if args.dry_run:
        emit({**context, "status": "dry_run", "target": target, "payload": payload})
        log(f"DRY-RUN: mode={mode} POST {target} payload={json.dumps(payload, ensure_ascii=True)}")
        return EXIT_OK

    timeout_sec = args.timeout_sec if args.timeout_sec is not None else channel.timeout_sec
    try:
        http_status, response_preview = post_json(url, payload, timeout_sec=timeout_sec)
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
        log(f"OK: alert delivered to Telegram ({mode}), http={http_status}")
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
    log(f"FAIL: Telegram returned http={http_status}")
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

