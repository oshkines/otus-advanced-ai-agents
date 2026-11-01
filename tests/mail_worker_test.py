"""Проверки ``agents/mail_worker.py``: конфиг, каскад white_list/ИИ, reconnect, коды выхода.

Сеть не используется: IMAP-клиент, ИИ-каскад и notifier подменяются фейками,
поэтому проверки идут офлайн и годятся для CI. Реальные ``aioimaplib``/``httpx``/
``openai`` не вызываются (проверяется только отсутствие потоков в исходнике).

Запуск (из корня проекта):
    .\\\\.venv\\\\Scripts\\\\python.exe tests\\\\mail_worker_test.py

Коды выхода: 0 - все проверки прошли, 1 - есть падения.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import json
import os
import sys
import tempfile
from collections import namedtuple
from pathlib import Path
from typing import Any, Callable, Sequence

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "agents"))

import mail_worker as mw  # noqa: E402 - импорт после правки sys.path

Response = namedtuple("Response", "result lines")

SECRET_PASSWORD: str = "unit-test-password"
SECRET_API_KEY: str = "unit-test-deepseek-key"
ENV_KEYS: tuple[str, ...] = (
    "ENV_DEEPSEEK_API_KEY",
    "ENV_MAIL_PRIMARY_USERNAME",
    "ENV_MAIL_PRIMARY_PASSWORD",
    "ENV_MAIL_SECONDARY_USERNAME",
    "ENV_MAIL_SECONDARY_PASSWORD",
)

checks: int = 0
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    """Фиксирует результат одной проверки (вывод - ASCII, чтобы консоль Windows не ломалась)."""
    global checks
    checks += 1
    if not condition:
        failures.append(f"{name}: {detail}" if detail else name)


def expect_config_error(name: str, call: Callable[[], Any]) -> None:
    """Проверяет, что вызов поднимает ``ConfigError``."""
    try:
        call()
    except mw.ConfigError:
        check(name, True)
    except Exception as exc:  # noqa: BLE001 - фиксируем тип неожиданной ошибки
        check(name, False, f"unexpected {type(exc).__name__}: {exc}")
    else:
        check(name, False, "ConfigError was not raised")


def expect_ai_error(name: str, call: Callable[[], Any]) -> None:
    """Проверяет, что вызов поднимает ``AiAnalysisError``."""
    try:
        call()
    except mw.AiAnalysisError:
        check(name, True)
    except Exception as exc:  # noqa: BLE001
        check(name, False, f"unexpected {type(exc).__name__}: {exc}")
    else:
        check(name, False, "AiAnalysisError was not raised")


class _Quiet:
    """Контекстный менеджер: глушит ``stdout``/``stderr`` воркера на время теста."""

    def __enter__(self) -> tuple[io.StringIO, io.StringIO]:
        self._out, self._err = io.StringIO(), io.StringIO()
        self._ctx_out = contextlib.redirect_stdout(self._out)
        self._ctx_err = contextlib.redirect_stderr(self._err)
        self._ctx_out.__enter__()
        self._ctx_err.__enter__()
        return self._out, self._err

    def __exit__(self, *exc_info: Any) -> None:
        self._ctx_err.__exit__(*exc_info)
        self._ctx_out.__exit__(*exc_info)


def quiet() -> _Quiet:
    """Возвращает контекстный менеджер тишины для вывода воркера."""
    return _Quiet()


def headers_bytes(
    *,
    sender: str = "Alice <alice@example.org>",
    subject: str = "Test subject",
    message_id: str = "m1@example.org",
    content_type: str = "text/plain; charset=utf-8",
    cte: str = "8bit",
) -> bytes:
    """Собирает сырые заголовки письма (с завершающей пустой строкой)."""
    lines = [
        f"From: {sender}",
        "To: worker@test",
        f"Subject: {subject}",
        "Date: Mon, 26 Oct 2026 12:00:00 +0300",
        f"Message-ID: <{message_id}>",
        "MIME-Version: 1.0",
        f"Content-Type: {content_type}",
        f"Content-Transfer-Encoding: {cte}",
        "",
        "",
    ]
    return "\r\n".join(lines).encode("utf-8")


def simple_message(
    *,
    sender: str = "Alice <alice@example.org>",
    subject: str = "Test subject",
    body: str = "Body text",
    message_id: str = "m1@example.org",
) -> bytes:
    """Собирает простое MIME-письмо ``text/plain`` в UTF-8."""
    lines = [
        f"From: {sender}",
        "To: worker@test",
        f"Subject: {subject}",
        "Date: Mon, 26 Oct 2026 12:00:00 +0300",
        f"Message-ID: <{message_id}>",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 8bit",
        "",
        body,
    ]
    return "\r\n".join(lines).encode("utf-8")

class FakeImap:
    """Минимальный двойник ``aioimaplib.IMAP4_SSL`` (только используемые команды)."""

    def __init__(
        self,
        messages: dict[str, dict[str, bytes]],
        *,
        fail_login_times: int = 0,
        fail_hello_times: int = 0,
        select_result: str = "OK",
    ) -> None:
        self.messages = messages
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.seen: list[str] = []
        self.fail_login_times = fail_login_times
        self.fail_hello_times = fail_hello_times
        self.select_result = select_result
        self.logged_out = False
        self._state = "NONAUTH"

    async def wait_hello_from_server(self) -> None:
        self.calls.append(("hello", ()))
        if self.fail_hello_times > 0:
            self.fail_hello_times -= 1
            raise ConnectionError("simulated greeting failure")

    async def login(self, user: str, password: str) -> Response:
        self.calls.append(("login", (user, password)))
        if self.fail_login_times > 0:
            self.fail_login_times -= 1
            raise ConnectionError("simulated IMAP disconnect")
        self._state = "AUTH"
        return Response("OK", [b"logged in"])

    async def select(self, mailbox: str = "INBOX") -> Response:
        self.calls.append(("select", (mailbox,)))
        if self.select_result == "OK":
            self._state = "SELECTED"
        return Response(self.select_result, [b"1"])

    async def search(self, *criteria: str) -> Response:
        self.calls.append(("search", tuple(criteria)))
        return Response("OK", [" ".join(self.messages).encode("ascii")])

    async def fetch(self, seq: str, part: str) -> Response:
        self.calls.append(("fetch", (seq, part)))
        message = self.messages.get(seq, {})
        if "HEADER" in part:
            payload = message.get("header", b"")
        elif "BODY.PEEK[1]" in part or "BODY.PEEK[TEXT]" in part:
            payload = message.get("text", b"")
        else:
            payload = message.get("body", b"")
        meta = f"{seq} FETCH (BODY[] {{{len(payload)}}}".encode("ascii")
        return Response("OK", [meta, payload, b")"])

    async def store(self, seq: str, *args: str) -> Response:
        self.calls.append(("store", (seq, *args)))
        self.seen.append(seq)
        return Response("OK", [b"stored"])

    async def logout(self) -> Response:
        self.logged_out = True
        return Response("BYE", [b"bye"])

    def get_state(self) -> str:
        """Как у ``aioimaplib.IMAP4.get_state``: ``NONAUTH``/``AUTH``/``SELECTED``."""
        return self._state

    def fetched_parts(self) -> list[str]:
        """Части письма, которые запрашивались через ``FETCH``."""
        return [str(args[1]) for name, args in self.calls if name == "fetch"]

    def command_names(self) -> list[str]:
        """Имена вызванных IMAP-команд (для проверки порядка и повторных сессий)."""
        return [name for name, _ in self.calls]


class FakeNotifier:
    """Двойник :class:`mw.CoreNotifier`: записывает payload-ы и умеет «падать»."""

    def __init__(self, *, results: Sequence[bool] | None = None) -> None:
        self.payloads: list[dict[str, Any]] = []
        self._results = list(results or [])
        self.event = asyncio.Event()

    async def send(self, payload: dict[str, Any]) -> bool:
        self.payloads.append(dict(payload))
        delivered = self._results.pop(0) if self._results else True
        if delivered:
            self.event.set()
        return delivered


_UNSET: Any = object()


def make_provider(**overrides: Any) -> mw.ProviderSettings:
    """Провайдер для тестов: домен ``example.com`` целиком в белом списке."""
    base: dict[str, Any] = {
        "id": "primary",
        "host": "imap.test",
        "port": 993,
        "username": "user@test",
        "password": SECRET_PASSWORD,
        "white_list": frozenset({"boss@example.com"}),
        "white_list_domains": frozenset({"example.com"}),
        "poll_interval_sec": 5.0,
        "connect_timeout_sec": 1.0,
        "command_timeout_sec": 1.0,
        "max_messages": 10,
    }
    base.update(overrides)
    return mw.ProviderSettings(**base)


def make_settings(
    provider: mw.ProviderSettings | None = None,
    *,
    ai: mw.AISettings | None = None,
    limits: mw.Limits | None = None,
    reconnect: mw.ReconnectSettings | None = None,
    enabled: bool = True,
) -> mw.Settings:
    """Собирает ``Settings`` напрямую, без чтения файла конфигурации."""
    return mw.Settings(
        config_path=PROJECT_ROOT / "config" / "orchestrator.json",
        enabled=enabled,
        ai=ai or mw.AISettings(api_key=SECRET_API_KEY),
        core=mw.CoreSettings(),
        limits=limits or mw.Limits(),
        reconnect=reconnect
        or mw.ReconnectSettings(initial_delay_sec=0.01, max_delay_sec=0.04, backoff_factor=1.5),
        providers=(provider or make_provider(),),
    )


async def _instant_sleep(delay: float) -> None:
    """Подмена ``asyncio.sleep``: тесты не должны ждать реальный backoff."""
    await asyncio.sleep(0)


def make_worker(
    settings: mw.Settings,
    imap: FakeImap,
    *,
    notifier: Any = None,
    classifier: Callable[..., Any] | None = None,
    summarizer: Callable[..., Any] | None = None,
    ai_client: Any = _UNSET,
    once: bool = True,
) -> mw.MailboxWorker:
    """Собирает воркер с внедрёнными фейками (сеть не используется)."""
    client = object() if ai_client is _UNSET else ai_client
    return mw.MailboxWorker(
        settings,
        settings.providers[0],
        ai_client=client,
        notifier=notifier if notifier is not None else FakeNotifier(),
        imap_factory=lambda provider: imap,
        classifier=classifier,
        summarizer=summarizer,
        once=once,
        sleeper=_instant_sleep,
    )


def single_message(
    *,
    sender: str = "Alice <alice@example.org>",
    subject: str = "Test subject",
    body: str = "Body text",
    message_id: str = "m1@example.org",
) -> dict[str, dict[str, bytes]]:
    """Одно письмо в формате, который ожидает :class:`FakeImap`."""
    return {
        "1": {
            "header": headers_bytes(sender=sender, subject=subject, message_id=message_id),
            "text": body.encode("utf-8")[:4096],
            "body": simple_message(sender=sender, subject=subject, body=body, message_id=message_id),
        }
    }

def test_text_helpers() -> None:
    """Белый список, MIME-заголовки, парсинг ответов IMAP, превью тела."""
    env_name = "ENV_MAIL_UNIT_USER"
    os.environ[env_name] = "env-user@test"
    try:
        check("env: ENV_* resolved", mw.resolve_env_value(env_name, field_name="x") == "env-user@test")
        check("env: literal passes", mw.resolve_env_value("plain@test", field_name="x") == "plain@test")
        check("env: empty optional", mw.resolve_env_value(None, field_name="x") == "")
        expect_config_error(
            "env: missing required raises",
            lambda: mw.resolve_env_value("ENV_MAIL_UNIT_ABSENT", field_name="x", required=True),
        )
    finally:
        os.environ.pop(env_name, None)

    check(
        "model: deepseek-reasoning alias",
        mw.normalize_model_name("deepseek-reasoning", "x") == "deepseek-reasoner",
    )
    check("model: DeepSeek-R1 alias", mw.normalize_model_name("DeepSeek-R1", "x") == "deepseek-reasoner")
    check("model: deepseek-v3 alias", mw.normalize_model_name("deepseek-v3", "x") == "deepseek-chat")
    check("model: unknown kept", mw.normalize_model_name("custom-model", "x") == "custom-model")

    check("address: extract + lower", mw.extract_email_address("Boss <BOSS@Example.COM>") == "boss@example.com")
    check("address: empty input", mw.extract_email_address("") == "")

    check("white list: exact", mw.is_whitelisted("boss@example.com", {"boss@example.com"}))
    check("white list: case-insensitive", mw.is_whitelisted("Boss@Example.com", {"boss@example.com"}))
    check("white list: domain", mw.is_whitelisted("hr@company.ru", set(), {"company.ru"}))
    check("white list: subdomain", mw.is_whitelisted("hr@mail.company.ru", set(), {"company.ru"}))
    check("white list: foreign rejected", not mw.is_whitelisted("hr@other.ru", set(), {"company.ru"}))
    check("white list: empty rejected", not mw.is_whitelisted("", {"boss@example.com"}))

    encoded_word = f"=?utf-8?B?{base64.b64encode('Привет'.encode('utf-8')).decode('ascii')}?="
    check("header: mime decoded", mw.decode_mime_header(encoded_word) == "Привет")
    check("header: plain text", mw.decode_mime_header("Plain subject") == "Plain subject")
    check("header: None", mw.decode_mime_header(None) == "")

    cleaned = mw.strip_html(
        "<html><style>p{color:red}</style><body><b>Hello</b> &amp; <i>world</i></body></html>"
    )
    check("html: tags removed", "Hello" in cleaned and "world" in cleaned and "<" not in cleaned, cleaned)
    check("html: entity decoded", "&" in cleaned, cleaned)

    check("search: numbers parsed", mw.parse_search_lines([b"3 1 2"]) == ["3", "1", "2"])
    check("search: empty response", mw.parse_search_lines([b""]) == [])

    meta = b"1 FETCH (BODY[HEADER] {12}"
    check("fetch: literal picked", mw.parse_fetch_literal([meta, b"header-bytes", b")"]) == b"header-bytes")
    check("fetch: no literal", mw.parse_fetch_literal([meta, b")"]) == b"")

    base64_body = base64.b64encode("Hello, base64!".encode()).decode("ascii")
    check(
        "partial: base64 decoded",
        mw.decode_partial(base64_body.encode(), transfer_encoding="base64") == "Hello, base64!",
    )
    check(
        "partial: quoted-printable decoded",
        mw.decode_partial(b"Hello=2C QP!", transfer_encoding="quoted-printable") == "Hello, QP!",
    )
    check("partial: utf-8", mw.decode_partial("Привет".encode("utf-8"), charset="utf-8") == "Привет")
    check(
        "partial: multipart preamble dropped",
        mw.decode_partial(b"--b\r\nContent-Type: text/plain\r\n\r\nText part", charset="utf-8").startswith(
            "Text part"
        ),
    )

    check("truncate: short unchanged", mw.truncate_text("short", 10) == "short")
    check("truncate: word boundary", mw.truncate_text("alpha beta gamma delta", 16) == "alpha beta…")
    check("truncate: zero limit", mw.truncate_text("text", 0) == "")

def test_classification_parsing() -> None:
    """Строгий JSON классификатора: обёртки, регистр, нарушения контракта."""
    plain = mw.parse_classification('{"category": "CRITICAL", "priority": "HIGH", "reason": "from CTO"}')
    check("classify: plain json", plain.category == "CRITICAL" and plain.priority == "HIGH")
    check("classify: reason kept", plain.reason == "from CTO")
    check("classify: is_critical", plain.is_critical and not plain.is_low)

    fenced = mw.parse_classification('```json\n{"category":"SPAM","priority":"LOW","reason":"ads"}\n```')
    check("classify: fenced json", fenced.category == "SPAM" and fenced.is_low)

    noisy = mw.parse_classification('Sure! {"category":"vacancy","priority":"high","reason":"hr"} done')
    check("classify: noise around json", noisy.category == "VACANCY" and noisy.priority == "HIGH")

    hyphen = mw.parse_classification('{"category":"SPAM-VALUABLE","priority":"HIGH"}')
    check("classify: hyphenated category", hyphen.category == "SPAM_VALUABLE")

    long_reason = mw.parse_classification(
        '{"category":"SPAM","priority":"LOW","reason":"' + "x" * 300 + '"}'
    )
    check("classify: reason truncated", len(long_reason.reason) <= mw.MAX_REASON_CHARS)

    expect_ai_error(
        "classify: unknown category",
        lambda: mw.parse_classification('{"category":"IMPORTANT","priority":"HIGH"}'),
    )
    expect_ai_error(
        "classify: bad priority",
        lambda: mw.parse_classification('{"category":"SPAM","priority":"MEDIUM"}'),
    )
    expect_ai_error("classify: non-json", lambda: mw.parse_classification("not json at all"))
    expect_ai_error("classify: empty", lambda: mw.parse_classification(""))
    expect_ai_error("classify: array root", lambda: mw.parse_classification("[]"))


def test_body_and_envelope() -> None:
    """Извлечение тела MIME-письма, разбор заголовков и payload для ядра."""
    plain = mw.extract_body_text(simple_message(body="Тело письма"))
    check("body: plain text", plain == "Тело письма", plain)

    multipart = (
        "From: Alice <alice@example.org>\r\n"
        "Subject: multi\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: multipart/alternative; boundary="b"\r\n\r\n'
        "--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain body\r\n"
        "--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML body</p>\r\n"
        "--b--\r\n"
    ).encode("utf-8")
    chosen = mw.extract_body_text(multipart)
    check("body: plain preferred", "Plain body" in chosen and "HTML" not in chosen, chosen)

    html_only = (
        "From: Alice <alice@example.org>\r\n"
        "Subject: html\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/html; charset="utf-8"\r\n'
        "Content-Transfer-Encoding: 8bit\r\n\r\n"
        "<p>Only <b>HTML</b></p>\r\n"
    ).encode("utf-8")
    html_text = mw.extract_body_text(html_only)
    check("body: html stripped", "Only" in html_text and "<" not in html_text, html_text)

    encoded = base64.b64encode("Секрет".encode("utf-8"))
    base64_message = (
        "From: Alice <alice@example.org>\r\n"
        "Subject: b64\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/plain; charset="utf-8"\r\n'
        "Content-Transfer-Encoding: base64\r\n\r\n"
    ).encode("utf-8") + encoded + b"\r\n"
    check("body: base64 cte", mw.extract_body_text(base64_message) == "Секрет", mw.extract_body_text(base64_message))
    check("body: empty raw", mw.extract_body_text(b"") == "")

    subject = f"=?utf-8?B?{base64.b64encode('Собеседование'.encode('utf-8')).decode('ascii')}?="
    envelope = mw.build_envelope(
        headers_bytes(sender="Boss <BOSS@Example.COM>", subject=subject, message_id="abc@example.org"),
        "7",
    )
    check("envelope: seq", envelope.seq == "7")
    check("envelope: address lower", envelope.address == "boss@example.com", envelope.address)
    check("envelope: subject decoded", envelope.subject == "Собеседование")
    check("envelope: message id", envelope.message_id == "abc@example.org", envelope.message_id)
    check("envelope: moscow offset", envelope.received_at.endswith("+03:00"), envelope.received_at)
    check("envelope: external id", envelope.external_id == "abc@example.org")

    fallback = mw.build_envelope(b"", "9")
    check("envelope: fallback external id ends with seq", fallback.external_id.endswith(":9"), fallback.external_id)

    payload = mw.build_payload(
        provider=make_provider(),
        envelope=envelope,
        action="classified",
        category="VACANCY",
        priority="HIGH",
        reason="hr",
        text="hello",
    )
    check("payload: channel", payload["channel"] == "email")
    check("payload: chat_id is provider", payload["chat_id"] == "primary")
    check("payload: external id", payload["external_id"] == "abc@example.org")
    check("payload: text length", payload["text_length"] == 5)
    check("payload: summary empty", payload["summary"] is None)
    check("payload: no password leaked", SECRET_PASSWORD not in json.dumps(payload, ensure_ascii=False))

def write_config(directory: Path, name: str, document: dict[str, Any]) -> Path:
    """Пишет временный JSON-конфиг (ASCII) и возвращает путь."""
    path = directory / name
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def write_text(directory: Path, name: str, text: str) -> Path:
    """Пишет произвольный текст во временный файл (для проверки битого JSON)."""
    path = directory / name
    path.write_text(text, encoding="utf-8")
    return path


def minimal_block(**overrides: Any) -> dict[str, Any]:
    """Минимальный валидный блок ``workers.mail_worker`` для временных конфигов."""
    block: dict[str, Any] = {
        "enabled": True,
        "providers": [
            {
                "id": "unit",
                "imap_host": "imap.unit",
                "username": "ENV_MAIL_PRIMARY_USERNAME",
                "password": "ENV_MAIL_PRIMARY_PASSWORD",
                "white_list": ["Boss@Example.COM"],
                "white_list_domains": ["@corp.test"],
            }
        ],
    }
    block.update(overrides)
    return block


def test_project_config() -> None:
    """Боевой ``config/orchestrator.json``: ящики, модели, адрес ядра, секреты из env."""
    project_config = PROJECT_ROOT / "config" / "orchestrator.json"
    settings = mw.load_settings(project_config)
    check("config: two providers", len(settings.providers) == 2)
    check("config: provider ids", [p.id for p in settings.providers] == ["primary", "secondary"])
    check("config: classifier model", settings.ai.classifier_model == "deepseek-chat")
    check("config: summarizer model", settings.ai.summarizer_model == "deepseek-reasoner")
    check("config: classify chars", settings.ai.classify_chars == 200)
    check("config: json mode", settings.ai.json_mode is True)
    check(
        "config: core endpoint",
        settings.core.endpoint == "http://127.0.0.1:8080/api/v1/notify",
        settings.core.endpoint,
    )
    check("config: api key from env", settings.ai.ready)
    check("config: credentials from env", all(provider.has_credentials for provider in settings.providers))
    check(
        "config: white list parsed",
        settings.providers[0].white_list == frozenset({"boss@example.com"}),
    )
    check("config: masked account", settings.providers[0].masked_account == "i***@yandex.ru")
    check(
        "config: limits",
        settings.limits.snippet_bytes == 4096 and settings.limits.max_delivery_attempts == 3,
    )
    check(
        "config: reconnect",
        settings.reconnect.initial_delay_sec == 5.0 and settings.reconnect.max_delay_sec == 300.0,
    )
    check("config: no secret in describe", SECRET_PASSWORD not in json.dumps(mw.describe_settings(settings, settings.providers), ensure_ascii=False))

    only = mw.load_settings(project_config, only_providers=["secondary"])
    check("config: --provider filter", len(only.providers) == 1 and only.providers[0].id == "secondary")
    expect_config_error(
        "config: unknown provider",
        lambda: mw.load_settings(project_config, only_providers=["nope"]),
    )

def test_temp_configs() -> None:
    """Временные конфиги: три формы блока, ошибки схемы, отсутствие секретов."""
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        current = write_config(directory, "ok.json", {"workers": {"mail_worker": minimal_block()}})
        parsed = mw.load_settings(current)
        check("config: white list normalized", parsed.providers[0].white_list == frozenset({"boss@example.com"}))
        check("config: domain normalized", parsed.providers[0].white_list_domains == frozenset({"corp.test"}))
        check("config: default search", parsed.providers[0].search == ("UNSEEN",))
        check("config: default core url", parsed.core.http_url == "http://127.0.0.1:8080")

        legacy = write_config(
            directory, "legacy.json", {"workers": [{"id": "mail_worker", **minimal_block()}]}
        )
        check("config: legacy list accepted", len(mw.load_settings(legacy).providers) == 1)

        flat = write_config(directory, "flat.json", {"mail_worker": minimal_block()})
        check("config: flat accepted", len(mw.load_settings(flat).providers) == 1)

        expect_config_error(
            "config: missing block",
            lambda: mw.load_settings(
                write_config(directory, "none.json", {"workers": {"vacancy_scanner": {}}})
            ),
        )
        expect_config_error(
            "config: providers not array",
            lambda: mw.load_settings(
                write_config(
                    directory, "badprov.json", {"workers": {"mail_worker": minimal_block(providers={})}}
                )
            ),
        )
        expect_config_error(
            "config: empty providers",
            lambda: mw.load_settings(
                write_config(directory, "empty.json", {"workers": {"mail_worker": minimal_block(providers=[])}})
            ),
        )
        expect_config_error(
            "config: provider without host",
            lambda: mw.load_settings(
                write_config(
                    directory,
                    "nohost.json",
                    {"workers": {"mail_worker": minimal_block(providers=[{"id": "x"}])}},
                )
            ),
        )
        expect_config_error(
            "config: bad core url",
            lambda: mw.load_settings(
                write_config(
                    directory,
                    "badurl.json",
                    {"workers": {"mail_worker": minimal_block(core={"http_url": "127.0.0.1:8080"})}},
                )
            ),
        )
        expect_config_error(
            "config: invalid json",
            lambda: mw.load_settings(write_text(directory, "broken.json", "{")),
        )
        expect_config_error("config: missing file", lambda: mw.load_settings(directory / "absent.json"))

        disabled = mw.load_settings(
            write_config(directory, "disabled.json", {"workers": {"mail_worker": minimal_block(enabled=False)}})
        )
        check("config: worker disabled", disabled.enabled is False)

        missing = write_config(
            directory,
            "nocreds.json",
            {
                "workers": {
                    "mail_worker": minimal_block(
                        providers=[
                            {
                                "id": "unit",
                                "imap_host": "imap.unit",
                                "username": "ENV_MAIL_UNIT_ABSENT_USER",
                                "password": "ENV_MAIL_UNIT_ABSENT_PASSWORD",
                            }
                        ]
                    )
                }
            },
        )
        check(
            "config: missing credentials tolerated",
            mw.load_settings(missing).providers[0].has_credentials is False,
        )

        alias = write_config(
            directory,
            "alias.json",
            {
                "workers": {
                    "mail_worker": minimal_block(
                        ai={"api_key": "ENV_DEEPSEEK_API_KEY", "summarizer_model": "deepseek-reasoning"}
                    )
                }
            },
        )
        check("config: summarizer alias", mw.load_settings(alias).ai.summarizer_model == "deepseek-reasoner")

        literal = write_config(
            directory,
            "literal.json",
            {
                "workers": {
                    "mail_worker": minimal_block(
                        providers=[
                            {
                                "id": "unit",
                                "imap_host": "imap.unit",
                                "username": "user@unit",
                                "password": "literal-password",
                            }
                        ]
                    )
                }
            },
        )
        literal_provider = mw.load_settings(literal).providers[0]
        check("config: literal credentials", literal_provider.has_credentials)
        check(
            "config: password hidden from repr",
            "literal-password" not in repr(literal_provider),
            repr(literal_provider),
        )

async def test_cascade_basic() -> None:
    """Каскад: white_list без ИИ, LOW без ядра, CRITICAL с саммари."""
    notifier = FakeNotifier()
    imap = FakeImap(
        single_message(sender="Boss <boss@example.com>", subject="Plan", body="Full body text")
    )
    classifier_calls: list[str] = []

    async def forbidden_classifier(client: Any, ai: Any, envelope: Any, snippet: str) -> mw.Classification:
        classifier_calls.append(snippet)
        return mw.Classification("SPAM", "LOW", "must not be used")

    worker = make_worker(make_settings(), imap, notifier=notifier, classifier=forbidden_classifier)
    with quiet() as (out, _err):
        processed = await worker.poll_once(imap)
    check("whitelist: processed", processed == 1, processed)
    check("whitelist: ai skipped", classifier_calls == [])
    check("whitelist: one payload", len(notifier.payloads) == 1)
    payload = notifier.payloads[0]
    check("whitelist: category", payload["category"] == "WHITELIST", payload["category"])
    check("whitelist: priority HIGH", payload["priority"] == "HIGH")
    check("whitelist: full body in text", "Full body text" in payload["text"])
    check("whitelist: full body fetched", "(BODY.PEEK[])" in imap.fetched_parts())
    check("whitelist: marked seen", imap.seen == ["1"])
    check("whitelist: event emitted", '"action": "whitelist"' in out.getvalue())

    low_calls: list[str] = []

    async def low_classifier(client: Any, ai: Any, envelope: Any, snippet: str) -> mw.Classification:
        low_calls.append(snippet)
        return mw.Classification("SPAM", "LOW", "bulk")

    notifier = FakeNotifier()
    imap = FakeImap(single_message(sender="Ads <ads@shop.test>", body="Buy now and save"))
    worker = make_worker(make_settings(), imap, notifier=notifier, classifier=low_classifier)
    with quiet() as (out, _err):
        processed = await worker.poll_once(imap)
    check("low: processed as handled", processed == 1, processed)
    check("low: classifier called once", len(low_calls) == 1)
    check("low: snippet bounded", len(low_calls[0]) <= mw.DEFAULT_CLASSIFY_CHARS)
    check("low: notifier untouched", notifier.payloads == [])
    check("low: marked seen", imap.seen == ["1"])
    check("low: no full body fetch", "(BODY.PEEK[])" not in imap.fetched_parts())
    check("low: event ignored_low", '"action": "ignored_low"' in out.getvalue())

    counters = {"classify": 0, "summarize": 0}

    async def critical_classifier(client: Any, ai: Any, envelope: Any, snippet: str) -> mw.Classification:
        counters["classify"] += 1
        return mw.Classification("CRITICAL", "HIGH", "deadline")

    async def critical_summarizer(client: Any, ai: Any, envelope: Any, body: str) -> str:
        counters["summarize"] += 1
        check("critical: summarizer got full body", "Full body" in body)
        return "1. Deadline Friday"

    notifier = FakeNotifier()
    imap = FakeImap(
        single_message(sender="CTO <cto@corp.test>", subject="Deadline", body="Full body of the letter")
    )
    worker = make_worker(
        make_settings(),
        imap,
        notifier=notifier,
        classifier=critical_classifier,
        summarizer=critical_summarizer,
    )
    with quiet():
        processed = await worker.poll_once(imap)
    check("critical: processed", processed == 1, processed)
    check("critical: classifier called", counters["classify"] == 1)
    check("critical: summarizer called", counters["summarize"] == 1)
    critical_payload = notifier.payloads[0]
    check("critical: category", critical_payload["category"] == "CRITICAL")
    check("critical: summary", critical_payload["summary"] == "1. Deadline Friday")
    check("critical: text is summary", critical_payload["text"] == "1. Deadline Friday")
    check("critical: marked seen", imap.seen == ["1"])

async def test_cascade_edges() -> None:
    """Каскад: VACANCY без полного тела, сбои доставки, отсутствие ИИ, дубли."""
    async def vacancy_classifier(client: Any, ai: Any, envelope: Any, snippet: str) -> mw.Classification:
        return mw.Classification("VACANCY", "HIGH", "hr offer")

    long_body = "vacancy " * 100
    notifier = FakeNotifier()
    imap = FakeImap(single_message(sender="HR <hr@job.test>", body=long_body))
    worker = make_worker(make_settings(), imap, notifier=notifier, classifier=vacancy_classifier)
    with quiet():
        processed = await worker.poll_once(imap)
    vacancy_payload = notifier.payloads[0]
    check("vacancy: processed", processed == 1)
    check("vacancy: category", vacancy_payload["category"] == "VACANCY")
    check("vacancy: text bounded", len(vacancy_payload["text"]) <= mw.DEFAULT_CLASSIFY_CHARS)
    check("vacancy: no summary", vacancy_payload["summary"] is None)
    check("vacancy: no full body fetch", "(BODY.PEEK[])" not in imap.fetched_parts())
    check("vacancy: marked seen", imap.seen == ["1"])

    notifier = FakeNotifier(results=[False])
    imap = FakeImap(single_message(sender="HR <hr@job.test>", body="vacancy"))
    worker = make_worker(make_settings(), imap, notifier=notifier, classifier=vacancy_classifier)
    with quiet():
        processed = await worker.poll_once(imap)
    check("delivery: processed zero", processed == 0, processed)
    check("delivery: not marked seen", imap.seen == [])
    check("delivery: payload attempted", len(notifier.payloads) == 1)

    notifier = FakeNotifier(results=[False])
    imap = FakeImap(single_message(sender="HR <hr@job.test>", body="vacancy"))
    settings = make_settings(limits=mw.Limits(max_delivery_attempts=1))
    worker = make_worker(settings, imap, notifier=notifier, classifier=vacancy_classifier)
    with quiet():
        await worker.poll_once(imap)
    check("delivery: dropped after limit", imap.seen == ["1"])

    notifier = FakeNotifier()
    imap = FakeImap(single_message(sender="Ads <ads@shop.test>", body="Buy"))
    worker = make_worker(make_settings(), imap, notifier=notifier, ai_client=None)
    with quiet():
        processed = await worker.poll_once(imap)
    check("ai missing: processed zero", processed == 0)
    check("ai missing: no payload", notifier.payloads == [])
    check("ai missing: not marked seen", imap.seen == [])

    entry = single_message(sender="HR <hr@job.test>", body="vacancy", message_id="dup@x")["1"]
    messages = {"1": entry, "2": dict(entry)}
    duplicate_calls: list[str] = []

    async def duplicate_classifier(client: Any, ai: Any, envelope: Any, snippet: str) -> mw.Classification:
        duplicate_calls.append(snippet)
        return mw.Classification("VACANCY", "HIGH", "hr")

    notifier = FakeNotifier()
    imap = FakeImap(messages)
    worker = make_worker(make_settings(), imap, notifier=notifier, classifier=duplicate_classifier)
    with quiet():
        processed = await worker.poll_once(imap)
    check("duplicate: both marked seen", imap.seen == ["1", "2"])
    check("duplicate: classifier once", len(duplicate_calls) == 1, len(duplicate_calls))
    check("duplicate: one payload", len(notifier.payloads) == 1)
    check("duplicate: processed both", processed == 2, processed)


async def test_reconnect() -> None:
    """Автопереподключение: первый login падает, второй проходит, письмо доставлено."""
    notifier = FakeNotifier()
    imap = FakeImap(single_message(sender="Boss <boss@example.com>", body="hello"), fail_login_times=1)
    worker = make_worker(make_settings(), imap, notifier=notifier, once=False)
    with quiet():
        task = asyncio.create_task(worker.run())
        try:
            await asyncio.wait_for(notifier.event.wait(), timeout=5)
            await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    logins = [args for name, args in imap.calls if name == "login"]
    check("reconnect: two login attempts", len(logins) == 2, len(logins))
    check("reconnect: credentials used", logins[-1][0] == "user@test")
    check("reconnect: message delivered once", len(notifier.payloads) == 1, len(notifier.payloads))
    check("reconnect: imap search repeated", imap.command_names().count("search") >= 1)

    # В режиме --once сбой подключения не приводит к бесконечным повторам.
    fail_imap = FakeImap(single_message(), fail_login_times=1)
    failing_worker = make_worker(make_settings(), fail_imap, once=True)
    raised = False
    with quiet():
        try:
            await failing_worker.run()
        except Exception:  # noqa: BLE001 - ожидаем проброс ошибки сессии
            raised = True
    check("once: connection failure raises", raised)
    check("once: single login attempt", [name for name, _ in fail_imap.calls].count("login") == 1)

    hello_fail = FakeImap(single_message(), fail_hello_times=1)
    hello_worker = make_worker(make_settings(), hello_fail, once=True)
    raised = False
    with quiet():
        try:
            await hello_worker.run()
        except Exception:  # noqa: BLE001 - ожидаем проброс ошибки сессии
            raised = True
    check("session: greeting failure raises", raised)
    check("session: no logout before auth", not hello_fail.logged_out)

    reject = FakeImap(single_message(), select_result="NO")
    reject_worker = make_worker(make_settings(), reject, once=True)
    raised = False
    with quiet():
        try:
            await reject_worker.run()
        except mw.ImapSessionError:
            raised = True
    check("session: select rejected raises", raised)
    check("session: logout after auth", reject.logged_out)

def test_cli() -> None:
    """CLI: ``--dry-run``, отсутствие секретов в выводе и коды выхода 0/2."""
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        config = write_config(directory, "cli.json", {"workers": {"mail_worker": minimal_block()}})

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = mw.main(["--config", str(config), "--dry-run"])
        check("cli: dry-run exit 0", code == 0, code)
        events = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        check("cli: dry-run event", bool(events) and events[0].get("status") == "dry_run")
        check("cli: provider listed", bool(events) and events[0]["providers"][0]["id"] == "unit")
        check("cli: no password in dry-run", SECRET_PASSWORD not in out.getvalue() + err.getvalue())

        nocreds = write_config(
            directory,
            "nocreds.json",
            {
                "workers": {
                    "mail_worker": minimal_block(
                        providers=[
                            {
                                "id": "unit",
                                "imap_host": "imap.unit",
                                "username": "ENV_MAIL_UNIT_ABSENT_USER",
                                "password": "ENV_MAIL_UNIT_ABSENT_PASSWORD",
                            }
                        ]
                    )
                }
            },
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = mw.main(["--config", str(nocreds)])
        check("cli: missing credentials exit 2", code == mw.EXIT_CONFIG_ERROR, code)
        check("cli: config error event", '"reason": "config_error"' in out.getvalue(), out.getvalue()[:120])

        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = mw.main(["--config", str(config), "--provider", "nope", "--dry-run"])
        check("cli: unknown provider exit 2", code == mw.EXIT_CONFIG_ERROR, code)

        disabled = write_config(
            directory, "disabled.json", {"workers": {"mail_worker": minimal_block(enabled=False)}}
        )
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = mw.main(["--config", str(disabled)])
        check("cli: disabled worker exit 0", code == 0, code)


def test_no_threads() -> None:
    """Pure Async: в исходнике нет потоков и ``asyncio.to_thread``."""
    source = (PROJECT_ROOT / "agents" / "mail_worker.py").read_text(encoding="utf-8")
    check("source: no to_thread", "to_thread(" not in source)
    check("source: no threading import", "import threading" not in source and "Thread(" not in source)
    check("source: gather used", "asyncio.gather" in source)
    check("source: aioimaplib used", "aioimaplib" in source)
    check("source: httpx used", "import httpx" in source)
    check("source: AsyncOpenAI used", "AsyncOpenAI" in source)
    check("source: reconnect backoff used", "next_delay" in source)


def main() -> int:
    """Запускает все проверки и возвращает код выхода 0/1."""
    backup = {key: os.environ.get(key) for key in ENV_KEYS}
    os.environ["ENV_DEEPSEEK_API_KEY"] = SECRET_API_KEY
    os.environ["ENV_MAIL_PRIMARY_USERNAME"] = "ivan@yandex.ru"
    os.environ["ENV_MAIL_PRIMARY_PASSWORD"] = SECRET_PASSWORD
    os.environ["ENV_MAIL_SECONDARY_USERNAME"] = "petr@mail.ru"
    os.environ["ENV_MAIL_SECONDARY_PASSWORD"] = SECRET_PASSWORD
    try:
        test_text_helpers()
        test_classification_parsing()
        test_body_and_envelope()
        test_project_config()
        test_temp_configs()
        asyncio.run(test_cascade_basic())
        asyncio.run(test_cascade_edges())
        asyncio.run(test_reconnect())
        test_cli()
        test_no_threads()
    finally:
        for key, value in backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    if failures:
        print(f"FAILED {len(failures)} of {checks} checks")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(f"RESULT: PASSED ({checks} checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())







