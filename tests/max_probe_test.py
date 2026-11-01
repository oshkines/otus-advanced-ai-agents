"""Проверки ``agents/max_probe.py``: ``GET /me``, сбор ``chat_id`` из ``GET /updates``, коды выхода.

Сеть не используется: ``get_json`` подменяется записывающей заглушкой, поэтому
проверки идут офлайн и годятся для CI.

Запуск (из корня проекта):
    .\\.venv\\Scripts\\python.exe tests\\max_probe_test.py

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

import max_probe as probe  # noqa: E402 - импорт после правки sys.path

SECRET_TOKEN: str = "max-test-token-value"
ENV_KEYS: tuple[str, ...] = ("ENV_VK_MAX_URL", "ENV_VK_MAX_TOKEN", "ENV_VK_MAX_CHAT_ID")
ME_URL: str = "https://platform-api2.max.ru/me"
UPDATES_URL: str = "https://platform-api2.max.ru/updates"

CHAT_IN_CHAT: int = 123456
CHAT_CHANNEL: int = 987654

ME_OK: str = json.dumps(
    {
        "user_id": 7001,
        "first_name": "Orchestrator",
        "name": "Orchestrator",
        "username": "orchestrator_bot",
        "is_bot": True,
    }
)

# Реалистичный ответ GET /updates: chat_id есть и в самом Update (bot_added),
# и только внутри message.recipient (message_created); у message_callback его нет.
UPDATES_OK: str = json.dumps(
    {
        "updates": [
            {
                "update_type": "message_created",
                "timestamp": 1761552000000,
                "chat_id": CHAT_IN_CHAT,
                "message": {"recipient": {"chat_id": CHAT_IN_CHAT, "chat_type": "chat"}},
            },
            {
                "update_type": "bot_added",
                "timestamp": 1761551900000,
                "chat_id": CHAT_CHANNEL,
                "is_channel": True,
            },
            {
                "update_type": "message_created",
                "timestamp": 1761552100000,
                "message": {"recipient": {"chat_id": CHAT_IN_CHAT, "chat_type": "chat"}},
            },
            {"update_type": "message_callback", "timestamp": 1761552200000},
        ],
        "marker": 1761552200000,
    }
)

checks: int = 0
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    """Фиксирует результат одной проверки (вывод - ASCII, чтобы консоль Windows не ломалась)."""
    global checks
    checks += 1
    if not condition:
        failures.append(f"{name}: {detail}" if detail else name)


def run_probe(
    argv: list[str],
    env: dict[str, str],
    responses: dict[str, Any],
) -> tuple[int, dict[str, Any], list[dict[str, Any]], str, str]:
    """Запускает ``main()`` с подменённым ``get_json``.

    :param responses: префикс URL -> ``(http_status, body)`` или исключение.
    :returns: ``(код выхода, JSON-событие, вызовы get_json, stdout, stderr)``.
    """
    saved = {key: os.environ.get(key) for key in ENV_KEYS}
    calls: list[dict[str, Any]] = []

    def fake_get_json(url: str, *, timeout_sec: float, headers: Any = None) -> tuple[int, str]:
        calls.append({"url": url, "headers": dict(headers or {}), "timeout_sec": timeout_sec})
        for prefix, response in responses.items():
            if url.startswith(prefix):
                if isinstance(response, Exception):
                    raise response
                status, body = response
                return int(status), str(body)
        return 404, '{"code": "not.found"}'

    original = probe.get_json
    probe.get_json = fake_get_json  # type: ignore[assignment]
    for key in ENV_KEYS:
        os.environ.pop(key, None)
    os.environ.update(env)

    out_buffer = io.StringIO()
    err_buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(out_buffer), contextlib.redirect_stderr(err_buffer):
            code = probe.main(argv)
    finally:
        probe.get_json = original  # type: ignore[assignment]
        for key in ENV_KEYS:
            os.environ.pop(key, None)
            if saved[key] is not None:
                os.environ[key] = saved[key]

    output = out_buffer.getvalue().strip()
    event: dict[str, Any] = {}
    if output:
        event = json.loads(output.splitlines()[-1])
    return code, event, calls, output, err_buffer.getvalue()



def test_me_ok() -> None:
    """Валидный токен: один ``GET /me``, заголовок ``Authorization``, токен не утекает."""
    code, event, calls, output, errors = run_probe(
        [], {"ENV_VK_MAX_TOKEN": SECRET_TOKEN}, {ME_URL: (200, ME_OK)}
    )
    bot = event.get("bot") or {}
    check("me: exit code 0", code == 0, f"got {code}")
    check("me: status ok", event.get("status") == "ok", str(event))
    check("me: single request", len(calls) == 1, f"got {len(calls)}")
    check("me: target url", bool(calls) and calls[0]["url"] == ME_URL, str(calls[:1]))
    check(
        "me: authorization header",
        bool(calls) and calls[0]["headers"].get("Authorization") == SECRET_TOKEN,
        str(calls[:1]),
    )
    check("me: bot user_id", bot.get("user_id") == 7001, str(bot))
    check("me: bot username", bot.get("username") == "orchestrator_bot", str(bot))
    check("me: bot flag", bot.get("is_bot") is True, str(bot))
    check("me: token not in stdout", SECRET_TOKEN not in output, "token leaked to stdout")
    check("me: token not in stderr", SECRET_TOKEN not in errors, "token leaked to stderr")


def test_chats() -> None:
    """``GET /updates``: уникальные ``chat_id`` из ``Update.chat_id`` и ``message.recipient``."""
    code, event, calls, output, errors = run_probe(
        ["--chats"],
        {"ENV_VK_MAX_TOKEN": SECRET_TOKEN},
        {ME_URL: (200, ME_OK), UPDATES_URL: (200, UPDATES_OK)},
    )
    chats = event.get("chats") or []
    check("chats: exit code 0", code == 0, f"got {code}")
    check("chats: two requests", len(calls) == 2, f"got {len(calls)}")
    check(
        "chats: updates query",
        len(calls) > 1 and calls[1]["url"] == f"{UPDATES_URL}?limit=100&timeout=0",
        str(calls[1:2]),
    )
    check(
        "chats: unique ids",
        [chat.get("chat_id") for chat in chats] == [CHAT_IN_CHAT, CHAT_CHANNEL],
        str(chats),
    )
    check("chats: chat type", bool(chats) and chats[0].get("chat_type") == "chat", str(chats[:1]))
    check(
        "chats: update types dedup",
        bool(chats) and chats[0].get("update_types") == ["message_created"],
        str(chats[:1]),
    )
    check(
        "chats: channel flag",
        len(chats) > 1 and chats[1].get("chat_type") == "channel",
        str(chats[1:2]),
    )
    check("chats: updates seen", event.get("updates_seen") == 4, str(event.get("updates_seen")))
    check(
        "chats: next step hint",
        "ENV_VK_MAX_CHAT_ID" in str(event.get("next_step", "")),
        str(event.get("next_step")),
    )
    check("chats: token not in stdout", SECRET_TOKEN not in output, "token leaked to stdout")
    check("chats: token not in stderr", SECRET_TOKEN not in errors, "token leaked to stderr")


def test_empty_updates() -> None:
    """Бот создан, но ещё не добавлен в чаты: это успех с подсказкой, а не ошибка."""
    code, event, _, _, _ = run_probe(
        ["--chats"],
        {"ENV_VK_MAX_TOKEN": SECRET_TOKEN},
        {ME_URL: (200, ME_OK), UPDATES_URL: (200, '{"updates": [], "marker": 1}')},
    )
    check("empty: exit code 0", code == 0, f"got {code}")
    check("empty: chats empty", event.get("chats") == [], str(event.get("chats")))
    check("empty: hint", "add the bot" in str(event.get("hint", "")), str(event.get("hint")))
    check("empty: no next_step", "next_step" not in event, str(event))


def test_unauthorized() -> None:
    """HTTP 401 от ``GET /me``: понятная причина и превью ответа без токена."""
    code, event, _, output, errors = run_probe(
        [], {"ENV_VK_MAX_TOKEN": "wrong-token-value"}, {ME_URL: (401, '{"code": "verify.token"}')}
    )
    check("401: exit code 1", code == 1, f"got {code}")
    check("401: reason unauthorized", event.get("reason") == "unauthorized", str(event))
    check("401: http status", event.get("http_status") == 401, str(event))
    check("401: preview kept", "verify.token" in str(event.get("response_preview")), str(event))
    check(
        "401: token not echoed",
        "wrong-token-value" not in output and "wrong-token-value" not in errors,
        "token leaked",
    )


def test_transport_error() -> None:
    """Сетевая ошибка: код 1 и ``reason=transport_error``, без стектрейса."""
    code, event, _, _, _ = run_probe(
        [], {"ENV_VK_MAX_TOKEN": SECRET_TOKEN}, {ME_URL: OSError("connection refused")}
    )
    check("net: exit code 1", code == 1, f"got {code}")
    check("net: reason transport_error", event.get("reason") == "transport_error", str(event))
    check("net: error text", "connection refused" in str(event.get("error")), str(event.get("error")))


def test_updates_failure() -> None:
    """Ошибки ``GET /updates``: HTTP 500 и невалидный JSON при уже проверенном токене."""
    code, event, _, _, _ = run_probe(
        ["--chats"],
        {"ENV_VK_MAX_TOKEN": SECRET_TOKEN},
        {ME_URL: (200, ME_OK), UPDATES_URL: (500, '{"code": "internal"}')},
    )
    check("updates 500: exit code 1", code == 1, f"got {code}")
    check("updates 500: reason http_error", event.get("reason") == "http_error", str(event))
    check("updates 500: http status", event.get("http_status") == 500, str(event))
    check(
        "updates 500: bot kept",
        (event.get("bot") or {}).get("username") == "orchestrator_bot",
        str(event.get("bot")),
    )

    code, event, _, _, _ = run_probe(
        ["--chats"],
        {"ENV_VK_MAX_TOKEN": SECRET_TOKEN},
        {ME_URL: (200, ME_OK), UPDATES_URL: (200, "not json")},
    )
    check("updates json: exit code 1", code == 1, f"got {code}")
    check("updates json: reason invalid_response", event.get("reason") == "invalid_response", str(event))
    check(
        "updates json: error text",
        "GET /updates" in str(event.get("error")),
        str(event.get("error")),
    )


def test_no_token() -> None:
    """Не задан ``ENV_VK_MAX_TOKEN``: код 2, подсказка про переменную, сеть не трогаем."""
    code, event, calls, _, _ = run_probe([], {}, {ME_URL: (200, ME_OK)})
    check("no token: exit code 2", code == 2, f"got {code}")
    check("no token: reason token_missing", event.get("reason") == "token_missing", str(event))
    check(
        "no token: env hint",
        "ENV_VK_MAX_TOKEN" in str(event.get("error", "")),
        str(event.get("error")),
    )
    check("no token: no network", not calls, f"got {len(calls)} calls")


def test_dry_run() -> None:
    """``--dry-run`` показывает цели запросов и не ходит в сеть."""
    code, event, calls, _, _ = run_probe(["--dry-run", "--chats"], {"ENV_VK_MAX_TOKEN": SECRET_TOKEN}, {})
    targets = event.get("targets") or []
    check("dry: exit code 0", code == 0, f"got {code}")
    check("dry: no network", not calls, f"got {len(calls)} calls")
    check("dry: status dry_run", event.get("status") == "dry_run", str(event))
    check("dry: two targets", len(targets) == 2, str(targets))
    check("dry: me target", bool(targets) and targets[0] == ME_URL, str(targets))
    check(
        "dry: query masked",
        len(targets) > 1 and targets[1] == f"{UPDATES_URL}?limit=***&timeout=***",
        str(targets),
    )


def test_helpers() -> None:
    """Разбор обновлений: строковый ``chat_id``, ``bool`` вместо int, мусор отбрасывается."""
    updates = [
        {"update_type": "bot_started", "chat_id": "555"},
        {"update_type": "message_created", "chat_id": True},
        {"update_type": "message_created", "chat_id": "not-a-number"},
        {
            "update_type": "message_created",
            "message": {"recipient": {"chat_id": 555, "chat_type": "dialog"}},
        },
    ]
    chats = probe.collect_chats(updates)
    check("helpers: single chat", len(chats) == 1, str(chats))
    check("helpers: string id parsed", bool(chats) and chats[0]["chat_id"] == 555, str(chats))
    check(
        "helpers: types merged",
        bool(chats) and chats[0]["update_types"] == ["bot_started", "message_created"],
        str(chats),
    )
    check("helpers: dialog type", bool(chats) and chats[0]["chat_type"] == "dialog", str(chats))


def run_checks() -> int:
    """Выполняет все группы проверок и печатает итог в стиле остальных тестов проекта."""
    for test in (
        test_me_ok,
        test_chats,
        test_empty_updates,
        test_unauthorized,
        test_transport_error,
        test_updates_failure,
        test_no_token,
        test_dry_run,
        test_helpers,
    ):
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

