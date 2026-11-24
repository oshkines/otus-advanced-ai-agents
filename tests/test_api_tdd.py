"""TDD-набор для Backend API (`api/main.py`): контракт, негативные кейсы, AI-каскад.

Тесты написаны ДО реализации (spec-driven TDD): `docs/api_spec.md` — источник истины,
`tests/test_api_tdd.py` — исполняемая спецификация. Сеть и токены не расходуются:
БД и LLM подменяются фейками (`FakeGateway`, `FakeLlm`), поэтому прогон детерминирован
и годится для CI.

Запуск (из корня проекта):
    .\\.venv\\Scripts\\python.exe -m pytest tests\\test_api_tdd.py -v

Критерий приёмки: exit code 0, все тесты passed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx
import pytest
from fastapi import FastAPI

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import api.main as api  # noqa: E402 - импорт после правки sys.path

API_PREFIX = "/api/v1"
NOW = datetime(2026, 11, 23, 10, 0, tzinfo=timezone.utc)

FOLDER_ROW: dict[str, Any] = {
    "id": 12,
    "account_id": 1,
    "name": "INBOX",
    "raw_name": "INBOX",
    "special_use": "\\Inbox",
    "is_selectable": True,
    "scan_mode": "full",
    "unread_count": 3,
    "message_count": 1042,
    "last_synced_at": datetime(2026, 11, 23, 9, 58, 11, tzinfo=timezone.utc),
}

EMAIL_ROW: dict[str, Any] = {
    "id": 55,
    "account_id": 1,
    "folder_id": 12,
    "folder_name": "INBOX",
    "message_id": "<vacancy-42@alfersoft.ru>",
    "external_id": "vacancy-42@alfersoft.ru",
    "sender": "hr@alfersoft.ru",
    "sender_name": "AlferSoft HR",
    "subject": "Стажировка C++ разработчик, зимний набор",
    "received_at": datetime(2026, 11, 23, 9, 40, tzinfo=timezone.utc),
    "category": "VACANCY",
    "priority": "HIGH",
    "ai_summary": "Стажировка C++20, дедлайн отклика 05.12.2026.",
    "spam_tag": None,
    "spam_url": None,
    "status": "classified",
    "is_seen": False,
    "is_deleted": False,
    "ai_model": "deepseek-chat",
    "error_text": None,
    "processed_at": datetime(2026, 11, 23, 9, 41, tzinfo=timezone.utc),
    "created_at": datetime(2026, 11, 23, 9, 42, tzinfo=timezone.utc),
}

SPAM_EMAIL_ROW: dict[str, Any] = {
    "id": 56,
    "account_id": 1,
    "folder_id": None,
    "folder_name": None,
    "message_id": "<promo-sale@shop.ru>",
    "external_id": "promo-sale@shop.ru",
    "sender": "promo@shop.ru",
    "sender_name": "Shop Promo",
    "subject": "Промокод SALE5000",
    "received_at": datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc),
    "category": "SPAM_VALUABLE",
    "priority": "LOW",
    "ai_summary": "Промокод SALE5000 на 5000 ₽ действует до воскресенья.",
    "spam_tag": "promo",
    "spam_url": "https://shop.ru/promo",
    "status": "new",
    "is_seen": False,
    "is_deleted": True,
    "ai_model": "deepseek-chat",
    "error_text": None,
    "processed_at": None,
    "created_at": datetime(2026, 11, 22, 12, 1, tzinfo=timezone.utc),
}

VACANCY_ROW: dict[str, Any] = {
    "id": 7,
    "source": "hh.ru",
    "external_id": "42",
    "title": "C++ Developer",
    "company": "AlferSoft",
    "stack": ["C++20", "CMake"],
    "tags": ["remote"],
    "salary_min": Decimal("180000.00"),
    "salary_max": Decimal("240000.00"),
    "currency": "RUB",
    "url": "https://hh.ru/vacancy/42",
    "published_at": datetime(2026, 11, 20, 8, 0, tzinfo=timezone.utc),
    "status": "new",
    "score": 88,
    "work_format": "remote",
    "is_ignored": False,
    "created_at": datetime(2026, 11, 20, 8, 1, tzinfo=timezone.utc),
    "updated_at": datetime(2026, 11, 20, 8, 1, tzinfo=timezone.utc),
    "raw": {"api": {"work_format": "remote"}},
}

TICKET_ROW: dict[str, Any] = {
    "id": 1,
    "direction_from": "Санкт-Петербург",
    "direction_to": "Москва",
    "travel_date": date(2026, 12, 26),
    "train_number": "016А",
    "car_type": "coupe",
    "seats_available": 12,
    "price_rub": Decimal("4820.00"),
    "booking_url": "https://ticket.rzd.ru/order/1",
    "status": "available",
    "passenger_name": None,
    "trip_window_start": date(2026, 12, 26),
    "trip_window_end": date(2027, 1, 9),
    "notified_at": None,
    "created_at": datetime(2026, 11, 21, 7, 0, tzinfo=timezone.utc),
    "updated_at": datetime(2026, 11, 21, 7, 0, tzinfo=timezone.utc),
}

INSTRUCTION_ROW: dict[str, Any] = {
    "model": "deepseek-chat",
    "fallback_model": "deepseek-reasoner",
    "max_tokens": 400,
    "temperature": Decimal("0.10"),
    "prompt": "Classify the incoming email and return strict JSON.",
}


# ---------------------------------------------------------------------------
# Фейк шлюза БД: те же методы, что у AsyncpgGateway, но данные в памяти.
# ---------------------------------------------------------------------------
class FakeGateway:
    """Двойник DatabaseGateway: журнал вызовов + детерминированные ответы."""

    def __init__(self, *, down: bool = False) -> None:
        self.down = down
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.folders: dict[int, dict[str, Any]] = {FOLDER_ROW["id"]: dict(FOLDER_ROW)}
        self.emails: list[dict[str, Any]] = [dict(EMAIL_ROW), dict(SPAM_EMAIL_ROW)]
        self.vacancies: dict[int, dict[str, Any]] = {VACANCY_ROW["id"]: dict(VACANCY_ROW)}
        self.tickets: dict[int, dict[str, Any]] = {TICKET_ROW["id"]: dict(TICKET_ROW)}
        self.instruction: dict[str, Any] | None = dict(INSTRUCTION_ROW)
        self.account_ids: list[int] = [1]
        self.saved_emails: list[dict[str, Any]] = []
        self.saved_spam: list[dict[str, Any]] = []
        self.saved_vacancies: list[dict[str, Any]] = []
        self._next_email_id = 901
        self._next_spam_id = 5001
        self._next_ai_vacancy_id = 7001
        self._next_vacancy_id = 101

    # -- служебное ---------------------------------------------------------
    def _log(self, name: str, **fields: Any) -> None:
        self.calls.append((name, fields))
        if self.down:
            raise api.DatabaseUnavailable("PostgreSQL недоступна: connection refused")

    def called(self, name: str) -> list[dict[str, Any]]:
        """Аргументы всех вызовов указанного метода (для assert'ов)."""
        return [fields for (call_name, fields) in self.calls if call_name == name]

    # -- системные ---------------------------------------------------------
    async def ping(self) -> float:
        self._log("ping")
        return 12.0

    async def pool_stats(self) -> tuple[int, int]:
        self._log("pool_stats")
        return (1, 1)

    # -- дашборд -----------------------------------------------------------
    async def fetch_dashboard(self) -> dict[str, Any]:
        self._log("fetch_dashboard")
        return {
            "mail": {
                "accounts": 1,
                "folders_synced": 19,
                "folders_watched": 19,
                "folders_skipped": 0,
                "emails_total": 4,
                "emails_new": 1,
                "emails_classified": 3,
                "last_sync_at": datetime(2026, 11, 23, 9, 58, tzinfo=timezone.utc),
            },
            "valuable_spam": {
                "total": 2,
                "last_7_days": 2,
                "top_tags": [{"tag": "promo", "count": 2}],
                "latest": [
                    {
                        "id": 4,
                        "spam_tag": "promo",
                        "spam_url": "https://shop.ru/promo",
                        "summary": "Промокод SALE5000",
                        "sender": "promo@shop.ru",
                        "subject": "Промокод",
                        "received_at": datetime(2026, 11, 22, 12, 0, tzinfo=timezone.utc),
                    }
                ],
            },
            "vacancies": {
                "total": 5,
                "active": 3,
                "ignored": 2,
                "by_work_format": {"remote": 2, "hybrid": 1, "office": 0, "unknown": 2},
                "last_published_at": datetime(2026, 11, 20, 8, 0, tzinfo=timezone.utc),
            },
            "rzhd": {
                "total": 4,
                "watching": 1,
                "available": 3,
                "booked": 0,
                "nearest_travel_date": date(2026, 12, 26),
                "cheapest_price_rub": 2650.0,
            },
            "ai": {
                "classifier_model": "deepseek-chat",
                "fallback_model": "deepseek-reasoner",
                "max_tokens": 400,
                "instructions_active": 2,
            },
        }

    # -- почтовые папки ----------------------------------------------------
    async def list_folders(
        self,
        *,
        account_id: int | None = None,
        scan_mode: str | None = None,
        is_selectable: bool | None = None,
    ) -> list[dict[str, Any]]:
        self._log(
            "list_folders",
            account_id=account_id,
            scan_mode=scan_mode,
            is_selectable=is_selectable,
        )
        rows = [dict(row) for row in self.folders.values()]
        if account_id is not None:
            rows = [row for row in rows if row["account_id"] == account_id]
        if scan_mode is not None:
            rows = [row for row in rows if row["scan_mode"] == scan_mode]
        if is_selectable is not None:
            rows = [row for row in rows if row["is_selectable"] is is_selectable]
        return rows

    async def update_folder(
        self,
        folder_id: int,
        *,
        is_selectable: bool | None,
        scan_mode: str | None,
    ) -> dict[str, Any] | None:
        self._log(
            "update_folder",
            folder_id=folder_id,
            is_selectable=is_selectable,
            scan_mode=scan_mode,
        )
        row = self.folders.get(folder_id)
        if row is None:
            return None
        updated = dict(row)
        if is_selectable is not None:
            updated["is_selectable"] = is_selectable
        if scan_mode is not None:
            updated["scan_mode"] = scan_mode
        self.folders[folder_id] = updated
        return dict(updated)

    # -- лента писем -------------------------------------------------------
    async def list_emails(
        self,
        *,
        limit: int,
        category: str | None = None,
        folder_id: int | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        self._log(
            "list_emails",
            limit=limit,
            category=category,
            folder_id=folder_id,
            status=status,
        )
        rows = [dict(row) for row in self.emails]
        if category is not None:
            rows = [row for row in rows if row["category"] == category]
        if folder_id is not None:
            rows = [row for row in rows if row["folder_id"] == folder_id]
        if status is not None:
            rows = [row for row in rows if row["status"] == status]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        return rows[:limit]

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
    ) -> tuple[list[dict[str, Any]], int]:
        self._log(
            "list_vacancies",
            status=status,
            work_format=work_format,
            is_ignored=is_ignored,
            query=query,
            limit=limit,
            offset=offset,
        )
        rows = [dict(row) for row in self.vacancies.values()]
        if status is not None:
            rows = [row for row in rows if row["status"] == status]
        if work_format is not None:
            rows = [row for row in rows if row["work_format"] == work_format]
        if is_ignored is not None:
            rows = [row for row in rows if row["is_ignored"] is is_ignored]
        if query:
            needle = query.lower()
            rows = [
                row
                for row in rows
                if needle in f"{row['title']} {row['company']}".lower()
            ]
        total = len(rows)
        return rows[offset : offset + limit], total

    async def create_vacancy(
        self, record: Mapping[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        self._log("create_vacancy", **dict(record))
        for row in self.vacancies.values():
            if (
                row["source"] == record["source"]
                and row["external_id"] == record["external_id"]
            ):
                merged = {**row, **dict(record), "id": row["id"]}
                self.vacancies[row["id"]] = merged
                return dict(merged), False
        vacancy_id = self._next_vacancy_id
        self._next_vacancy_id += 1
        row = {
            **VACANCY_ROW,
            **dict(record),
            "id": vacancy_id,
            "created_at": NOW,
            "updated_at": NOW,
            "raw": {"api": {"work_format": record.get("work_format")}},
        }
        self.vacancies[vacancy_id] = row
        return dict(row), True

    async def update_vacancy(
        self, vacancy_id: int, changes: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        self._log("update_vacancy", vacancy_id=vacancy_id, **dict(changes))
        row = self.vacancies.get(vacancy_id)
        if row is None:
            return None
        merged = {**row, **{key: value for key, value in changes.items() if value is not None}}
        merged["updated_at"] = NOW
        merged["raw"] = {
            **(row.get("raw") or {}),
            "api": {
                "work_format": merged.get("work_format"),
                "is_ignored": merged.get("is_ignored"),
            },
        }
        self.vacancies[vacancy_id] = merged
        return dict(merged)

    async def hide_vacancy(self, vacancy_id: int) -> dict[str, Any] | None:
        self._log("hide_vacancy", vacancy_id=vacancy_id)
        row = self.vacancies.get(vacancy_id)
        if row is None:
            return None
        hidden = {**row, "is_ignored": True, "updated_at": NOW}
        self.vacancies[vacancy_id] = hidden
        return dict(hidden)

    # -- РЖД ---------------------------------------------------------------
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
    ) -> tuple[list[dict[str, Any]], int]:
        self._log(
            "list_tickets",
            status=status,
            car_type=car_type,
            direction_from=direction_from,
            direction_to=direction_to,
            travel_date_from=travel_date_from,
            travel_date_to=travel_date_to,
            only_available=only_available,
            limit=limit,
            offset=offset,
        )
        rows = [dict(row) for row in self.tickets.values()]
        if status is not None:
            rows = [row for row in rows if row["status"] == status]
        if car_type is not None:
            rows = [row for row in rows if row["car_type"] == car_type]
        if only_available:
            rows = [row for row in rows if row["seats_available"] > 0]
        total = len(rows)
        return rows[offset : offset + limit], total

    async def create_ticket(
        self, record: Mapping[str, Any]
    ) -> tuple[dict[str, Any], bool]:
        self._log("create_ticket", **dict(record))
        for row in self.tickets.values():
            same_offer = (
                row["direction_from"] == record["direction_from"]
                and row["direction_to"] == record["direction_to"]
                and row["travel_date"] == record["travel_date"]
                and row["train_number"] == record["train_number"]
                and row["car_type"] == record["car_type"]
            )
            if same_offer:
                merged = {**row, **dict(record), "id": row["id"], "updated_at": NOW}
                self.tickets[row["id"]] = merged
                return dict(merged), False
        ticket_id = 501
        row = {
            **TICKET_ROW,
            **dict(record),
            "id": ticket_id,
            "created_at": NOW,
            "updated_at": NOW,
        }
        self.tickets[ticket_id] = row
        return dict(row), True

    # -- ИИ: конфиг из ai_instructions и запись результата ------------------
    async def fetch_ai_instruction(self, scope_key: str) -> dict[str, Any] | None:
        self._log("fetch_ai_instruction", scope_key=scope_key)
        return dict(self.instruction) if self.instruction is not None else None

    async def resolve_account_id(self, account_id: int | None) -> int | None:
        self._log("resolve_account_id", account_id=account_id)
        if account_id is not None:
            return account_id
        return self.account_ids[0] if self.account_ids else None

    async def save_email_classification(self, **fields: Any) -> int:
        self._log("save_email_classification", **fields)
        email_id = self._next_email_id
        self._next_email_id += 1
        self.saved_emails.append({"id": email_id, **fields})
        return email_id

    async def upsert_valuable_spam(self, **fields: Any) -> int:
        self._log("upsert_valuable_spam", **fields)
        spam_id = self._next_spam_id
        self._next_spam_id += 1
        self.saved_spam.append({"id": spam_id, **fields})
        return spam_id

    async def insert_ai_vacancy(self, **fields: Any) -> int:
        self._log("insert_ai_vacancy", **fields)
        vacancy_id = self._next_ai_vacancy_id
        self._next_ai_vacancy_id += 1
        self.saved_vacancies.append({"id": vacancy_id, **fields})
        return vacancy_id


# ---------------------------------------------------------------------------
# Фейк LLM: очередь ответов на модель (строка / исключение / задержка).
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Slow:
    """Ответ с искусственной задержкой: проверяет жёсткий таймаут ``wait_for``."""

    seconds: float
    value: Any


def classification_json(category: str = "VACANCY", **overrides: Any) -> str:
    """Собирает JSON-ответ модели в формате Structured Output."""
    payload: dict[str, Any] = {
        "category": category,
        "summary": "Стажировка C++ разработчика, дедлайн 05.12.",
        "spam_tag": None,
        "spam_url": None,
        "work_format": None,
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


SPAM_JSON: str = classification_json(
    "SPAM_VALUABLE",
    summary="Промокод SALE5000 на 5000 ₽ действует до воскресенья.",
    spam_tag="promo",
    spam_url="https://shop.ru/promo",
)


class FakeLlm:
    """Двойник LlmClient: записывает запросы и отдаёт заранее заданные ответы."""

    def __init__(
        self,
        responses: Mapping[str, Sequence[Any]] | None = None,
        default: Any = None,
    ) -> None:
        self.responses: dict[str, list[Any]] = {
            model: list(queue) for model, queue in (responses or {}).items()
        }
        self.default = classification_json() if default is None else default
        self.calls: list[dict[str, Any]] = []

    async def complete(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, str]],
        max_tokens: int,
        temperature: float | None,
        json_mode: bool,
    ) -> str:
        self.calls.append(
            {
                "model": model,
                "messages": [dict(message) for message in messages],
                "max_tokens": max_tokens,
                "temperature": temperature,
                "json_mode": json_mode,
            }
        )
        queue = self.responses.get(model) or []
        item: Any = queue.pop(0) if queue else self.default
        while isinstance(item, Slow):
            await asyncio.sleep(item.seconds)
            item = item.value
        if isinstance(item, BaseException):
            raise item
        return str(item)

    @property
    def models(self) -> list[str]:
        """Модели в порядке фактических вызовов."""
        return [call["model"] for call in self.calls]


# ---------------------------------------------------------------------------
# Сборка приложения и клиента (без lifespan: пул и LLM подставляются руками).
# ---------------------------------------------------------------------------
BASE_SETTINGS: dict[str, Any] = {
    "api_key": "unit-test-key",
    "model": "deepseek-chat",
    "fallback_model": "deepseek-reasoner",
    "max_tokens": 400,
    "temperature": 0.1,
    "timeout_sec": 1.0,
    "retry_attempts": 3,
    "retry_base_delay_sec": 0.0,
    "database_url": "postgresql://navigator_worker:unit-test@127.0.0.1:5432/ai_dev_navigator",
}


def build_app(
    *,
    gateway: Any = None,
    llm: Any = None,
    **overrides: Any,
) -> FastAPI:
    """Создаёт приложение с фейковыми зависимостями (аналог старта lifespan)."""
    settings = api.ApiSettings.from_env(load_env=False, **{**BASE_SETTINGS, **overrides})
    app = api.create_app(settings)
    app.state.gateway = gateway
    app.state.llm = llm
    return app


@contextlib.asynccontextmanager
async def client_for(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """httpx.AsyncClient поверх ASGI-транспорта: реальный HTTP-стек без сокетов."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


def run(scenario: Callable[[], Awaitable[None]]) -> None:
    """Запускает async-сценарий теста (без pytest-asyncio: детерминированный loop)."""
    asyncio.run(scenario())


def error_code(response: httpx.Response) -> str:
    """Достаёт ``detail.code`` из конверта ошибки."""
    detail = response.json().get("detail")
    assert isinstance(detail, dict), f"expected error envelope, got {response.text}"
    return str(detail.get("code"))


# ---------------------------------------------------------------------------
# 1-9: системные ручки, CORS, дашборд, почтовые папки.
# ---------------------------------------------------------------------------
def test_health_ok() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["database"]["status"] == "ok"
        assert body["database"]["latency_ms"] == 12
        assert body["ai"]["provider"] == "deepseek"
        assert body["ai"]["ready"] is True

    run(scenario)


def test_health_degraded_without_db() -> None:
    async def scenario() -> None:
        app = build_app(gateway=None)
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "degraded"
        assert body["database"]["status"] == "unavailable"

    run(scenario)


def test_cors_preflight_allows_frontend() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway())
        async with client_for(app) as client:
            response = await client.options(
                f"{API_PREFIX}/health",
                headers={
                    "Origin": "http://localhost:3000",
                    "Access-Control-Request-Method": "GET",
                },
            )
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"

    run(scenario)


def test_dashboard_summary() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/dashboard/summary")
        assert response.status_code == 200
        body = response.json()
        assert body["database"]["status"] == "ok"
        assert body["mail"]["folders_synced"] == 19
        assert body["valuable_spam"]["top_tags"] == [{"tag": "promo", "count": 2}]
        assert body["vacancies"]["active"] == 3
        assert body["vacancies"]["by_work_format"]["remote"] == 2
        assert body["rzhd"]["available"] == 3
        assert body["ai"]["classifier_model"] == "deepseek-chat"
        assert gateway.called("fetch_dashboard"), "сводка должна строиться одним запросом"

    run(scenario)


def test_dashboard_summary_db_unavailable() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway(down=True))
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/dashboard/summary")
        assert response.status_code == 503
        assert error_code(response) == "db_unavailable"

    run(scenario)


def test_list_mail_folders() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/mail/folders", params={"account_id": 1})
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert body["items"][0]["scan_mode"] == "full"
        assert body["items"][0]["name"] == "INBOX"
        assert gateway.called("list_folders")[0]["account_id"] == 1

    run(scenario)


def test_patch_mail_folder() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.patch(
                f"{API_PREFIX}/mail/folders/12",
                json={"scan_mode": "headers", "is_selectable": True},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["scan_mode"] == "headers"
        assert body["is_selectable"] is True
        call = gateway.called("update_folder")[0]
        assert call["folder_id"] == 12
        assert call["scan_mode"] == "headers"

    run(scenario)


def test_patch_mail_folder_not_found() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        gateway.folders.clear()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.patch(
                f"{API_PREFIX}/mail/folders/404", json={"scan_mode": "skip"}
            )
        assert response.status_code == 404
        assert error_code(response) == "not_found"

    run(scenario)


def test_patch_mail_folder_validation() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway())
        async with client_for(app) as client:
            bad_mode = await client.patch(
                f"{API_PREFIX}/mail/folders/12", json={"scan_mode": "everything"}
            )
            empty_body = await client.patch(f"{API_PREFIX}/mail/folders/12", json={})
            extra_field = await client.patch(
                f"{API_PREFIX}/mail/folders/12", json={"scan_mode": "full", "owner": "me"}
            )
        assert bad_mode.status_code == 422
        assert empty_body.status_code == 422
        assert extra_field.status_code == 422

    run(scenario)


# ---------------------------------------------------------------------------
# 9a-9b: лента писем из таблицы emails (GET /api/v1/emails).
# ---------------------------------------------------------------------------
def test_list_emails_feed() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/emails")
            filtered = await client.get(
                f"{API_PREFIX}/emails",
                params={
                    "limit": 1,
                    "category": "VACANCY",
                    "folder_id": 12,
                    "status": "classified",
                },
            )
            bad_category = await client.get(
                f"{API_PREFIX}/emails", params={"category": "NEWSLETTER"}
            )
            bad_limit = await client.get(f"{API_PREFIX}/emails", params={"limit": 0})

        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 2
        assert body["limit"] == 20
        first = body["items"][0]
        assert first["id"] == 55, "порядок обязан быть created_at DESC"
        assert first["subject"] == EMAIL_ROW["subject"]
        assert first["sender"] == "hr@alfersoft.ru"
        assert first["category"] == "VACANCY"
        assert first["priority"] == "HIGH"
        assert first["ai_summary"] == EMAIL_ROW["ai_summary"]
        assert first["folder_name"] == "INBOX"
        assert first["status"] == "classified"
        assert body["items"][1]["folder_name"] is None, "folder_id может быть NULL"
        assert gateway.called("list_emails")[0]["limit"] == 20

        assert filtered.status_code == 200
        filtered_body = filtered.json()
        assert filtered_body["total"] == 1
        assert filtered_body["limit"] == 1
        assert filtered_body["items"][0]["id"] == 55
        call = gateway.called("list_emails")[1]
        assert call["category"] == "VACANCY"
        assert call["folder_id"] == 12
        assert call["status"] == "classified"
        assert call["limit"] == 1

        assert bad_category.status_code == 422
        assert bad_limit.status_code == 422

    run(scenario)


def test_list_emails_db_unavailable() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway(down=True))
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/emails")
        assert response.status_code == 503
        assert error_code(response) == "db_unavailable"

    run(scenario)


# ---------------------------------------------------------------------------
# 10-16: вакансии (CRUD, фильтры, мягкое скрытие).
# ---------------------------------------------------------------------------
def test_list_vacancies_filters() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        params = {
            "status": "new",
            "work_format": "remote",
            "is_ignored": "false",
            "q": "C++",
            "limit": 10,
            "offset": 0,
        }
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/vacancies", params=params)
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert body["limit"] == 10
        assert body["offset"] == 0
        assert body["items"][0]["work_format"] == "remote"
        call = gateway.called("list_vacancies")[0]
        assert call["work_format"] == "remote"
        assert call["is_ignored"] is False
        assert call["status"] == "new"
        assert call["query"] == "C++"
        assert call["limit"] == 10
        assert call["offset"] == 0

    run(scenario)


def test_list_vacancies_invalid_work_format() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway())
        async with client_for(app) as client:
            response = await client.get(
                f"{API_PREFIX}/vacancies", params={"work_format": "on_site"}
            )
        assert response.status_code == 422

    run(scenario)


def test_create_vacancy() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        payload = {
            "source": "hh.ru",
            "external_id": "99",
            "title": "Python-инженер автоматизации",
            "company": "DataForge",
            "stack": ["Python 3.12"],
            "salary_min": 170000,
            "salary_max": 220000,
            "url": "https://hh.ru/vacancy/99",
            "work_format": "remote",
        }
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/vacancies", json=payload)
        assert response.status_code == 201
        body = response.json()
        assert body["id"] == 101
        assert body["work_format"] == "remote"
        assert body["salary_min"] == 170000.0
        assert gateway.called("create_vacancy")[0]["external_id"] == "99"

    run(scenario)


def test_create_vacancy_validation() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway())
        async with client_for(app) as client:
            no_title = await client.post(
                f"{API_PREFIX}/vacancies", json={"source": "hh.ru", "external_id": "1"}
            )
            bad_salary = await client.post(
                f"{API_PREFIX}/vacancies",
                json={
                    "source": "hh.ru",
                    "external_id": "1",
                    "title": "C++ Developer",
                    "salary_min": 300000,
                    "salary_max": 100000,
                },
            )
            bad_url = await client.post(
                f"{API_PREFIX}/vacancies",
                json={
                    "source": "hh.ru",
                    "external_id": "1",
                    "title": "C++ Developer",
                    "url": "javascript:alert(1)",
                },
            )
        assert no_title.status_code == 422
        assert bad_salary.status_code == 422
        assert bad_url.status_code == 422

    run(scenario)


def test_patch_vacancy_ignore_office() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.patch(
                f"{API_PREFIX}/vacancies/7",
                json={"work_format": "office", "is_ignored": True},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["is_ignored"] is True
        assert body["work_format"] == "office"
        call = gateway.called("update_vacancy")[0]
        assert call["vacancy_id"] == 7
        assert call["is_ignored"] is True

    run(scenario)


def test_patch_vacancy_not_found() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        gateway.vacancies.clear()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.patch(
                f"{API_PREFIX}/vacancies/999", json={"is_ignored": True}
            )
        assert response.status_code == 404
        assert error_code(response) == "not_found"

    run(scenario)


def test_delete_vacancy_soft_hide() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        async with client_for(app) as client:
            response = await client.delete(f"{API_PREFIX}/vacancies/7")
        assert response.status_code == 200
        body = response.json()
        assert body["is_ignored"] is True
        assert body["id"] == 7
        assert gateway.called("hide_vacancy"), "DELETE обязан идти через мягкое скрытие"
        hard_deletes = [name for (name, _fields) in gateway.calls if "delete" in name]
        assert hard_deletes == [], f"физическое удаление запрещено RLS: {hard_deletes}"

    run(scenario)


# ---------------------------------------------------------------------------
# 17-19: билеты РЖД.
# ---------------------------------------------------------------------------
def test_list_rzhd_tickets() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        params = {"only_available": "true", "car_type": "coupe", "limit": 20, "offset": 0}
        async with client_for(app) as client:
            response = await client.get(f"{API_PREFIX}/rzhd/tickets", params=params)
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert body["items"][0]["car_type"] == "coupe"
        assert body["items"][0]["seats_available"] == 12
        call = gateway.called("list_tickets")[0]
        assert call["only_available"] is True
        assert call["car_type"] == "coupe"

    run(scenario)


def test_create_rzhd_ticket() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        app = build_app(gateway=gateway)
        payload = {
            "direction_from": "Москва",
            "direction_to": "Санкт-Петербург",
            "travel_date": "2027-01-09",
            "train_number": "004А",
            "car_type": "sv",
            "seats_available": 4,
            "price_rub": 12400,
            "booking_url": "https://ticket.rzd.ru/order/2",
            "status": "available",
            "trip_window_start": "2026-12-26",
            "trip_window_end": "2027-01-09",
        }
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/rzhd/tickets", json=payload)
        assert response.status_code == 201
        body = response.json()
        assert body["id"] == 501
        assert body["car_type"] == "sv"
        assert body["price_rub"] == 12400.0
        assert body["travel_date"] == "2027-01-09"
        assert gateway.called("create_ticket")[0]["train_number"] == "004А"

    run(scenario)


def test_create_rzhd_ticket_validation() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway())
        base = {
            "direction_from": "Москва",
            "direction_to": "Санкт-Петербург",
            "travel_date": "2027-01-09",
        }
        async with client_for(app) as client:
            bad_car = await client.post(
                f"{API_PREFIX}/rzhd/tickets", json={**base, "car_type": "wagon"}
            )
            bad_window = await client.post(
                f"{API_PREFIX}/rzhd/tickets",
                json={
                    **base,
                    "car_type": "coupe",
                    "trip_window_start": "2027-01-09",
                    "trip_window_end": "2026-12-26",
                },
            )
            no_direction = await client.post(
                f"{API_PREFIX}/rzhd/tickets",
                json={"travel_date": "2027-01-09", "car_type": "coupe"},
            )
        assert bad_car.status_code == 422
        assert bad_window.status_code == 422
        assert no_direction.status_code == 422

    run(scenario)


# ---------------------------------------------------------------------------
# 20-27: AI-классификация (Structured Output, retry, fallback, persist).
# ---------------------------------------------------------------------------
EMAIL_PAYLOAD: dict[str, Any] = {
    "kind": "email",
    "sender": "hr@alfersoft.ru",
    "sender_name": "AlferSoft HR",
    "subject": "Стажировка C++ разработчик, зимний набор",
    "text": "Приглашаем стажёров C++20, дедлайн отклика 05.12.2026.",
}


def test_ai_classify_preview_email() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm()
        app = build_app(gateway=gateway, llm=llm)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "email"
        assert body["classification"]["category"] == "VACANCY"
        assert body["classification"]["priority"] == "HIGH"
        assert body["persisted"]["email_id"] == 901
        assert body["ai"]["used_model"] == "deepseek-chat"
        assert body["ai"]["attempts"] == 1
        assert body["ai"]["fallback_used"] is False
        assert body["ai"]["max_tokens"] == 400
        assert body["ai"]["json_mode"] is True

        call = llm.calls[0]
        assert call["model"] == "deepseek-chat"
        assert call["temperature"] == pytest.approx(0.1)
        assert "Стажировка" in call["messages"][-1]["content"]

        saved = gateway.saved_emails[0]
        assert saved["category"] == "VACANCY"
        assert saved["priority"] == "HIGH"
        assert saved["status"] == "classified"
        assert saved["ai_model"] == "deepseek-chat"
        assert gateway.called("fetch_ai_instruction")[0]["scope_key"] == "classifier"

    run(scenario)


def test_ai_classify_preview_spam_valuable() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm(default=SPAM_JSON)
        app = build_app(gateway=gateway, llm=llm)
        payload = {
            **EMAIL_PAYLOAD,
            "sender": "promo@shop.ru",
            "subject": "Промокод на 5000 ₽",
            "text": "Только сегодня: промокод SALE5000. https://shop.ru/promo",
        }
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["classification"]["category"] == "SPAM_VALUABLE"
        assert body["classification"]["spam_tag"] == "promo"
        assert body["classification"]["spam_url"] == "https://shop.ru/promo"
        assert body["persisted"]["valuable_spam_id"] == 5001

        email = gateway.saved_emails[0]
        assert email["status"] == "deleted"
        assert email["is_deleted"] is True
        spam = gateway.saved_spam[0]
        assert spam["spam_tag"] == "promo"
        assert spam["spam_url"] == "https://shop.ru/promo"
        assert spam["email_id"] == 901

    run(scenario)


def test_ai_classify_preview_retry_on_invalid_json() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm(
            responses={"deepseek-chat": ["не JSON, а обычный текст", classification_json()]}
        )
        app = build_app(gateway=gateway, llm=llm)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 200
        body = response.json()
        assert body["ai"]["attempts"] == 2
        assert body["ai"]["used_model"] == "deepseek-chat"
        assert body["ai"]["fallback_used"] is False
        assert len(llm.calls) == 2
        assert "JSON" in llm.calls[1]["messages"][-1]["content"]

    run(scenario)


def test_ai_classify_preview_fallback_model() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm(
            responses={
                "deepseek-chat": [
                    asyncio.TimeoutError(),
                    asyncio.TimeoutError(),
                    asyncio.TimeoutError(),
                ]
            }
        )
        app = build_app(gateway=gateway, llm=llm)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 200
        body = response.json()
        assert body["ai"]["fallback_used"] is True
        assert body["ai"]["used_model"] == "deepseek-reasoner"
        assert body["ai"]["attempts"] == 4
        assert llm.models == [
            "deepseek-chat",
            "deepseek-chat",
            "deepseek-chat",
            "deepseek-reasoner",
        ]

    run(scenario)


def test_ai_classify_preview_all_models_fail() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm(
            responses={
                "deepseek-chat": [RuntimeError("502 provider down")] * 3,
                "deepseek-reasoner": [RuntimeError("503 model overloaded")] * 3,
            }
        )
        app = build_app(gateway=gateway, llm=llm)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 502
        assert error_code(response) == "llm_unavailable"
        assert len(llm.calls) == 6
        assert gateway.saved_emails == []

    run(scenario)


def test_ai_classify_preview_db_unavailable() -> None:
    async def scenario() -> None:
        gateway = FakeGateway(down=True)
        llm = FakeLlm()
        app = build_app(gateway=gateway, llm=llm)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 503
        assert error_code(response) == "db_unavailable"
        assert llm.calls == [], "без ai_instructions модель не зовём (контроль стоимости)"

    run(scenario)


def test_ai_classify_preview_budget_from_db() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        gateway.instruction = {**INSTRUCTION_ROW, "max_tokens": 137}
        llm = FakeLlm()
        app = build_app(gateway=gateway, llm=llm)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 200
        body = response.json()
        assert body["ai"]["max_tokens"] == 137
        assert llm.calls[0]["max_tokens"] == 137

    run(scenario)


def test_ai_classify_preview_persist_false() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm()
        app = build_app(gateway=gateway, llm=llm)
        payload = {**EMAIL_PAYLOAD, "persist": False}
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["persisted"] == {
            "email_id": None,
            "valuable_spam_id": None,
            "vacancy_id": None,
        }
        assert gateway.called("save_email_classification") == []
        assert gateway.called("upsert_valuable_spam") == []

    run(scenario)


def test_ai_classify_preview_hard_timeout() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        slow = Slow(0.25, classification_json())
        llm = FakeLlm(responses={"deepseek-chat": [slow, slow, slow]})
        app = build_app(gateway=gateway, llm=llm, timeout_sec=0.05)
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=EMAIL_PAYLOAD)
        assert response.status_code == 200
        body = response.json()
        assert body["ai"]["timeout_sec"] == pytest.approx(0.05)
        assert body["ai"]["fallback_used"] is True
        assert body["ai"]["used_model"] == "deepseek-reasoner"

    run(scenario)


def test_ai_classify_preview_vacancy() -> None:
    async def scenario() -> None:
        gateway = FakeGateway()
        llm = FakeLlm(
            default=classification_json(
                "VACANCY", work_format="remote", summary="Удалёнка, C++20."
            )
        )
        app = build_app(gateway=gateway, llm=llm)
        payload = {
            "kind": "vacancy",
            "vacancy_title": "C++ Developer (Middle)",
            "company": "AlferSoft",
            "url": "https://hh.ru/vacancy/42",
            "text": "C++20, CMake, полностью удалённая работа, вилка 180-240 тыс.",
        }
        async with client_for(app) as client:
            response = await client.post(f"{API_PREFIX}/ai/classify-preview", json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "vacancy"
        assert body["classification"]["work_format"] == "remote"
        assert body["persisted"]["vacancy_id"] == 7001
        assert body["persisted"]["email_id"] is None
        saved = gateway.saved_vacancies[0]
        assert saved["work_format"] == "remote"
        assert saved["title"] == "C++ Developer (Middle)"
        assert saved["company"] == "AlferSoft"

    run(scenario)


def test_ai_classify_preview_validation() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway(), llm=FakeLlm())
        async with client_for(app) as client:
            empty_text = await client.post(
                f"{API_PREFIX}/ai/classify-preview", json={"kind": "email", "text": ""}
            )
            no_title = await client.post(
                f"{API_PREFIX}/ai/classify-preview",
                json={"kind": "vacancy", "text": "Описание вакансии"},
            )
            extra = await client.post(
                f"{API_PREFIX}/ai/classify-preview",
                json={**EMAIL_PAYLOAD, "prompt": "override"},
            )
        assert empty_text.status_code == 422
        assert no_title.status_code == 422
        assert extra.status_code == 422

    run(scenario)


def test_openapi_contains_all_endpoints() -> None:
    async def scenario() -> None:
        app = build_app(gateway=FakeGateway(), llm=FakeLlm())
        async with client_for(app) as client:
            response = await client.get("/openapi.json")
        assert response.status_code == 200
        paths = set(response.json()["paths"])
        expected = {
            f"{API_PREFIX}/health",
            f"{API_PREFIX}/dashboard/summary",
            f"{API_PREFIX}/mail/folders",
            f"{API_PREFIX}/mail/folders/{{folder_id}}",
            f"{API_PREFIX}/mail/sync-folders",
            f"{API_PREFIX}/emails",
            f"{API_PREFIX}/vacancies",
            f"{API_PREFIX}/vacancies/{{vacancy_id}}",
            f"{API_PREFIX}/rzhd/tickets",
            f"{API_PREFIX}/ai/classify-preview",
        }
        assert expected <= paths, f"missing: {expected - paths}"
        assert len(paths) == len(expected)

    run(scenario)










