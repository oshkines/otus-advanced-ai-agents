"""Backend API (FastAPI) AI Dev Navigator.

Пакет содержит единственный модуль :mod:`api.main` — ASGI-приложение, которое
фронтенд Next.js (`web/`) использует как источник данных для Bento-дашборда.
Контракт описан в ``docs/api_spec.md``, тесты — ``tests/test_api_tdd.py``.
"""

from __future__ import annotations

__all__ = ["main"]
