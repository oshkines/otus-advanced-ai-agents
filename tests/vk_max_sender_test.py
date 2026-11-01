"""Проверки ``agents/vk_max_sender.py``: выбор транспорта, JSON по MAX Bot API, коды выхода.

Сеть не используется: ``post_json`` подменяется записывающей заглушкой, поэтому
проверки идут офлайн и годятся для CI.

Запуск (из корня проекта):
    .\\.venv\\Scripts\\python.exe tests\\vk_max_sender_test.py

Коды выхода: 0 - все проверки прошли, 1 - есть падения.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "agents"))

import vk_max_sender as sender  # noqa: E402 - импорт после правки sys.path

SECRET_TOKEN: str = "max-test-token-value"
CHAT_ID: str = "1531779838"
WEBHOOK_URL: str = "http://127.0.0.1:8765/vk"
ENV_KEYS: tuple[str, ...] = ("ENV_VK_MAX_URL", "ENV_VK_MAX_TOKEN", "ENV_VK_MAX_CHAT_ID")

checks: int = 0
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    """Фиксирует результат одной проверки (вывод - ASCII, чтобы консоль Windows не ломалась)."""
    global checks
    checks += 1
    if not condition:
        failures.append(f"{name}: {detail}" if detail else name)


def run_sender(argv: list[str], env: dict[str, str]) -> tuple[int, dict[str, Any], list[dict[str, Any]], str]:
    """Запускает ``main()`` с подменённым ``post_json``; возвращает код, событие, вызовы и stdout."""
    saved = {key: os.environ.get(key) for key in ENV_KEYS}
    calls: list[dict[str, Any]] = []

    def fake_post_json(
        url: str,
        payload: Any,
        *,
        timeout_sec: float,
        headers: Any = None,
    ) -> tuple[int, str]:
        calls.append(
            {
                "url": url,
                "payload": json.loads(json.dumps(payload)),
                "headers": dict(headers or {}),
                "timeout_sec": timeout_sec,
            }
        )
        return 200, '{"success": true}'

    original = sender.post_json
    sender.post_json = fake_post_json  # type: ignore[assignment]
    for key in ENV_KEYS:
        os.environ.pop(key, None)
    os.environ.update(env)

    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            code = sender.main(argv)
    finally:
        sender.post_json = original  # type: ignore[assignment]
        for key in ENV_KEYS:
            os.environ.pop(key, None)
            if saved[key] is not None:
                os.environ[key] = saved[key]

    output = buffer.getvalue().strip()
    event: dict[str, Any] = {}
    if output:
        event = json.loads(output.splitlines()[-1])
    return code, event, calls, output


def test_webhook_mode() -> None:
    """Вебхук: конверт проекта, без заголовка Authorization."""
    code, event, calls, _ = run_sender(
        ["--now", "2026-10-26T12:00:00", "core down"],
        {"ENV_VK_MAX_URL": WEBHOOK_URL},
    )
    payload = calls[0]["payload"] if calls else {}
    check("webhook: exit code 0", code == 0, f"got {code}")
    check("webhook: status sent", event.get("status") == "sent", str(event))
    check("webhook: delivery_mode", event.get("delivery_mode") == "webhook", str(event.get("delivery_mode")))
    check("webhook: single POST", len(calls) == 1, f"got {len(calls)}")
    check("webhook: target url", bool(calls) and calls[0]["url"] == WEBHOOK_URL, str(calls[:1]))
    check(
        "webhook: envelope keys",
        set(payload) == {"channel", "text", "source", "sent_at", "work_hours_only"},
        str(sorted(payload)),
    )
    check("webhook: payload text", payload.get("text") == "core down", str(payload.get("text")))
    check("webhook: channel name", payload.get("channel") == "vk_max", str(payload.get("channel")))
    check(
        "webhook: no Authorization header",
        bool(calls) and "Authorization" not in calls[0]["headers"],
        str(calls[:1]),
    )


def test_work_hours_policy() -> None:
    """Окно 09:00-18:00 МСК: вне окна - код 3 без POST, ``--force`` отправляет."""
    code, event, calls, _ = run_sender(
        ["--now", "2026-10-26T20:00:00", "after hours"],
        {"ENV_VK_MAX_URL": WEBHOOK_URL},
    )
    check("defer: exit code 3", code == 3, f"got {code}")
    check("defer: status deferred", event.get("status") == "deferred", str(event))
    check("defer: reason", event.get("reason") == "outside_work_hours", str(event.get("reason")))
    check("defer: no network call", not calls, f"got {len(calls)} calls")

    code, event, calls, _ = run_sender(
        ["--force", "--now", "2026-10-26T20:00:00", "forced"],
        {"ENV_VK_MAX_URL": WEBHOOK_URL},
    )
    check("force: exit code 0", code == 0, f"got {code}")
    check("force: delivered", len(calls) == 1, f"got {len(calls)}")
    check("force: status sent", event.get("status") == "sent", str(event))



def test_max_api_mode() -> None:
    """MAX Bot API: POST /messages?chat_id=, заголовок Authorization, тело {"text": ...}."""
    env = {"ENV_VK_MAX_TOKEN": SECRET_TOKEN, "ENV_VK_MAX_CHAT_ID": CHAT_ID}
    code, event, calls, output = run_sender(
        ["--now", "2026-10-26T12:00:00", "max native"], env
    )
    payload = calls[0]["payload"] if calls else {}
    headers = calls[0]["headers"] if calls else {}
    expected_url = f"https://platform-api2.max.ru/messages?chat_id={CHAT_ID}"
    check("max api: exit code 0", code == 0, f"got {code}")
    check("max api: delivery_mode", event.get("delivery_mode") == "max_bot_api", str(event.get("delivery_mode")))
    check("max api: target url", bool(calls) and calls[0]["url"] == expected_url, str(calls[:1]))
    check("max api: body is NewMessageBody", payload == {"text": "max native"}, str(payload))
    check("max api: authorization header", headers.get("Authorization") == SECRET_TOKEN, str(headers))
    check("max api: token not printed", SECRET_TOKEN not in output, "secret leaked to stdout")
    check(
        "max api: target masked",
        event.get("target") == expected_url.replace(CHAT_ID, "***"),
        str(event.get("target")),
    )

    # Вебхук приоритетнее Bot API, если заданы оба транспорта.
    both = {**env, "ENV_VK_MAX_URL": WEBHOOK_URL}
    code, event, calls, _ = run_sender(["--now", "2026-10-26T12:00:00", "both"], both)
    check("both: webhook wins", event.get("delivery_mode") == "webhook", str(event.get("delivery_mode")))
    check("both: posted to webhook", bool(calls) and calls[0]["url"] == WEBHOOK_URL, str(calls[:1]))


def test_dry_run() -> None:
    """``--dry-run`` не ходит в сеть и показывает payload выбранного транспорта."""
    code, event, calls, _ = run_sender(
        ["--dry-run", "--now", "2026-10-26T12:00:00", "max dry"],
        {"ENV_VK_MAX_TOKEN": SECRET_TOKEN, "ENV_VK_MAX_CHAT_ID": CHAT_ID},
    )
    check("dry max: exit code 0", code == 0, f"got {code}")
    check("dry max: no network", not calls, f"got {len(calls)} calls")
    check("dry max: status dry_run", event.get("status") == "dry_run", str(event.get("status")))
    check("dry max: payload", event.get("payload") == {"text": "max dry"}, str(event.get("payload")))
    check(
        "dry max: chat id masked",
        str(event.get("target", "")).endswith("chat_id=***"),
        str(event.get("target")),
    )

    code, event, calls, _ = run_sender(
        ["--dry-run", "--now", "2026-10-26T12:00:00", "hook dry"],
        {"ENV_VK_MAX_URL": WEBHOOK_URL},
    )
    check("dry webhook: exit code 0", code == 0, f"got {code}")
    check("dry webhook: no network", not calls, f"got {len(calls)} calls")
    check(
        "dry webhook: envelope kept",
        isinstance(event.get("payload"), dict)
        and event["payload"].get("channel") == "vk_max"
        and event["payload"].get("text") == "hook dry",
        str(event.get("payload")),
    )


def test_config_errors() -> None:
    """Нет транспорта, битый chat_id и литеральный плейсхолдер - код 2 с понятным текстом."""
    code, event, calls, _ = run_sender(["--now", "2026-10-26T12:00:00", "nowhere"], {})
    check("no transport: exit code 2", code == 2, f"got {code}")
    check("no transport: reason", event.get("reason") == "webhook_placeholder", str(event))
    check("no transport: env hint", "ENV_VK_MAX_URL" in str(event.get("error", "")), str(event.get("error")))
    check("no transport: no network", not calls, f"got {len(calls)} calls")

    code, event, _, _ = run_sender(
        ["--now", "2026-10-26T12:00:00", "bad chat"],
        {"ENV_VK_MAX_TOKEN": SECRET_TOKEN, "ENV_VK_MAX_CHAT_ID": "chat-42"},
    )
    check("bad chat: exit code 2", code == 2, f"got {code}")
    check("bad chat: reason", event.get("reason") == "config_error", str(event))
    check("bad chat: int64 hint", "int64" in str(event.get("error", "")), str(event.get("error")))

    code, event, calls, _ = run_sender(
        ["--now", "2026-10-26T12:00:00", "placeholder"],
        {"ENV_VK_MAX_URL": "https://<webhook>"},
    )
    check("placeholder: exit code 2", code == 2, f"got {code}")
    check("placeholder: reason", event.get("reason") == "webhook_placeholder", str(event))
    check("placeholder: no network", not calls, f"got {len(calls)} calls")


def run_checks() -> int:
    """Выполняет все группы проверок и печатает итог в стиле остальных тестов проекта."""
    for test in (test_webhook_mode, test_work_hours_policy, test_max_api_mode, test_dry_run, test_config_errors):
        test()
    print(f"checks={checks} failures={len(failures)}")
    for failure in failures:
        print(f"FAILED: {failure}")
    if failures:
        print("RESULT: FAILED")
        return 1
    print("RESULT: PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(run_checks())
