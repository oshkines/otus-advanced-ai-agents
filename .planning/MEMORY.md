# Журнал памяти проекта

> Источник: перенесено из `docs/memory.md` (26.10.2026) без изменения смысла.

## Что сделано
- Сформирован этап Discovery в рамках ДЗ-2.
- Базовый стек жестко зафиксирован под Windows 11 (MSVC, CMake), без использования WSL.
- 26.10.2026: развернута физическая структура проекта (`config/`, `agents/`, `src/`, `core/`, `tests/`).
- 26.10.2026: создан `config/orchestrator.json` (workers, расписание, SQLite-кэш, UI, e2e-секция).
- 26.10.2026: Тест-маяк 2 закрыт на Python: `tests/browser_test.py` (Playwright) открывает `src/status_panel.html` и снимает скриншот `.planning/screenshots/green_e2e_test.png` (1440x900, PASS). Node.js не использовался.
- 26.10.2026: документация переведена в GSD-структуру `.planning/`, папка `docs/` удалена.
- 01.11.2026: инициализирована Phase 5 (bento-дашборд): `.planning/phases/phase-05-bento-dashboard/`
  с `DISCUSS.md`, `DESIGN.md`, `CONTRACT.md`. Выбран вариант A (Next.js App Router + Tailwind v4,
  конфиг читается Server Components) с точкой расширения до BFF (вариант B).
- 01.11.2026: `config/orchestrator.json` → v0.2.0: добавлены `ui.dashboard.navigation` (ASCII,
  подписи по `label_key`) и описания воркеров `email_watcher` / `rzhd_watcher` (`enabled: false`).
- 01.11.2026: создан скелет `web/` (маршруты `/`, `/email`, `/vacancies`, `/rzhd`); данные каналов —
  MOCK до реализации воркеров (Phase 6).

## Ловушки и ограничения
- Не давать ИИ-агенту Cline трогать файлы `.env`.
- Все токены от Telegram читать строго через переменные окружения Windows.
- Кириллица в консоли Windows: Python печатает в cp1251, PowerShell читает в cp866 — служебный вывод тестов держим в ASCII, иначе получаем кракозябры.
- `python.exe` в `WindowsApps` — заглушка Microsoft Store, реального Python в системе может не быть; используем `uv` + локальный `.venv`.
- Абсолютный путь проекта содержит пробелы и кириллицу — в тестах обязателен `Path.as_uri()` для `file://`, склейка строк ломается.
