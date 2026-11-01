# PROGRESS: AI Dev Orchestrator

> Источник: перенесено из `docs/plan.md` (26.10.2026) с обновлением путей на GSD-структуру.
> Фазы и их состав описаны в `.planning/ROADMAP.md`.

## Phase 0 — Discovery `DONE`

- [x] Сформирован этап Discovery (ДЗ-2): выбран стек и ИИ-среда.
- [x] Стек жёстко зафиксирован под Windows 11 native (MSVC 2022, CMake), без WSL.
- [x] Подключён MCP-сервер `context7` для актуализации документации библиотек.
- [x] Создан `CLAUDE.md` с архитектурными и поведенческими ограничениями моделей.
- [x] Режим работы по умолчанию — `plan` (сначала фиксируем шаги, потом код).

## Phase 1 — Каркас репозитория и безопасность `DONE`

### Настройка окружения

- [x] **Шаг 1: Развернуть папки и базовые файлы архитектуры GSD.**
      Выполнено 26.10.2026: `config/`, `agents/`, `src/`, `core/`, `tests/`, `config/orchestrator.json`.
- [x] **Шаг 2: Прописать правила безопасности в настройках Cline.**
      Выполнено: `.clinerules` (запрет чтения/изменения `.env`, режим по умолчанию `plan`) + `CLAUDE.md`.
- [x] **Шаг 3: Проверить блокировку `.env` (Тест-маяк 1).**
      Проверено 26.10.2026: агент отказался выводить содержимое `.env` со ссылкой на `.clinerules`
      и предложил безопасные альтернативы.
- [x] **Шаг 4: Написать e2e-тест на Playwright для проверки UI/Web (Тест-маяк 2).**
      Выполнено на Python (без Node.js): `tests/browser_test.py` + `src/status_panel.html`,
      скриншот `.planning/screenshots/green_e2e_test.png` (PNG 1440x900, exit code 0).
- [x] Развёрнуто локальное Python-окружение: `.venv` на CPython 3.12.14 через `uv`,
      `playwright==1.64.1`, браузеры `chromium-1248` + `chromium-headless-shell`.
- [x] Добавлен `.gitignore` (`.env`, `.venv/`, `build/`, `*.db`, артефакты Playwright).
- [x] Документация переведена в GSD-структуру `.planning/`, папка `docs/` выведена из проекта.

- [x] **Шаг 5: Автоматический хук валидации перед коммитом.**
      Создан `pre-commit.bat` в корне проекта (3 проверки: наличие файла, кодировка без кириллицы,
      валидность JSON). Проверено на 5 сценариях: валидный конфиг → exit 0; UTF-8+кириллица → exit 1;
      UTF-8+BOM без кириллицы → exit 0; битый JSON → exit 1; CP1251 → exit 1.

## Phase 2 — Разработка ядра C++20 `PLANNED`

- [ ] `CMakeLists.txt` + `CMakePresets.json` (MSVC 2022, C++20, vcpkg).
- [ ] `src/main.cpp`: чтение и валидация `config/orchestrator.json`.
- [ ] Планировщик запуска воркеров по полю `schedule`.
- [ ] Менеджер процессов: запуск воркеров, `timeout_sec`, сбор JSON из `stdout`.
- [ ] SQLite3-кэш дедупликации (`data/cache.db`).

## Phase 3 — Интеграция с Telegram `PLANNED`

- [ ] `agents/telegram_watcher.py` (`aiogram`/`telebot`, typing annotations).
- [ ] Токены только из окружения Windows (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
- [ ] Мок-режим `--dry-run` и юнит-тесты на парсинг апдейтов.
- [ ] Дедупликация сообщений через SQLite-кэш.

## Phase 4 — Интеграция с Яндекс.Макс `PLANNED`

- [ ] `agents/yandex_max_worker.py` — адаптер к API Яндекс.Макс.
- [ ] Единая схема JSON-сообщений для Telegram и Яндекс.Макс.
- [ ] Изоляция сбоев канала (падение воркера не роняет ядро).
- [ ] Интеграционный тест с моками API.

## Phase 5 — Bento Dashboard UI (Next.js 15 + Tailwind v4) `IN PROGRESS`

### Обсуждение и контракт

- [x] Прочитаны актуальные артефакты GSD (`.planning/*`), `config/orchestrator.json`,
      `src/status_panel.html`, `pre-commit.bat`, `.clinerules`, `CLAUDE.md`.
- [x] Зафиксировано отсутствие `design.md` и `.clinerules/gsd.md`; роль gsd-правил выполняют
      `.planning/ROADMAP.md` + `.planning/PROGRESS.md`.
- [x] Фаза инициализирована по конвенции `/gsd-discuss-phase`:
      `.planning/phases/phase-05-bento-dashboard/DISCUSS.md` (+ `DESIGN.md`, `CONTRACT.md`).
- [x] Выбран вариант **A (Config-SSR)** с точкой расширения до B (BFF + polling).
- [x] Согласованы ответы на 6 открытых вопросов (обзор на `/`, Email-вердикты, РЖД = места/цены/
      типы вагонов на каникулы Алфёровского вуза, `web/`, SQLite как будущий источник, `pre-commit.bat` не трогаем).

### Реализация скелета `web/`

- [x] Каркас Next.js: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `next-env.d.ts`.
- [x] Tailwind CSS v4 CSS-first: `app/globals.css` (`@import "tailwindcss"` + `@theme`-токены).
- [x] Слой конфига: `lib/orchestrator/{types,schema,config,derive,status,source,snapshot}.ts`, `lib/i18n/ru.ts`.
- [x] App Shell: `components/layout/{AppShell,Sidebar,Topbar,SectionHeader,StatusBadge}.tsx`.
- [x] Bento: `components/bento/{BentoGrid,BentoCard,Metric}.tsx` + `components/cards/*`.
- [x] Маршруты: `/` (обзор), `/email`, `/vacancies`, `/rzhd` (данные-заглушки `lib/mock/*`).
- [x] `config/orchestrator.json` v0.2.0: `ui.dashboard.navigation`, `email_watcher`, `rzhd_watcher`.
- [x] `.gitignore`: `node_modules/`, `.next/`, `out/`, `*.tsbuildinfo`.
- [ ] `tests/browser_test_dashboard.py` — Playwright Python e2e + скриншот (следующий шаг).
- [ ] Ветка B: `app/api/dashboard/route.ts` + `httpDashboardSource` + polling (backlog фазы).

## Артефакты

| Файл | Назначение |
|------|------------|
| `config/orchestrator.json` | Стартовая конфигурация C++20 core: workers, расписание, SQLite-кэш, UI, e2e |
| `src/status_panel.html` | Заглушка статус-панели оркестратора (self-contained, без внешних CDN) |
| `tests/browser_test.py` | E2E-тест Playwright (Python): проверяет GREEN-статус и снимает скриншот |
| `tests/requirements-dev.txt` | Dev-зависимости тестов (`playwright==1.64.1`) |
| `.planning/screenshots/green_e2e_test.png` | Доказательство прохождения e2e (Тест-маяк 2) |
| `pre-commit.bat` | Auto hook: валидация конфига перед коммитом (файл, кодировка, JSON), коды выхода 0/1 |
| `.gitignore` | Исключает `.env`, `.venv/`, `build/`, БД и артефакты Playwright из git |
| `.planning/phases/phase-05-bento-dashboard/DISCUSS.md` | Решения обсуждения Phase 5 (вариант A + ответы на 6 вопросов) |
| `.planning/phases/phase-05-bento-dashboard/DESIGN.md` | Bento-спека: сетка, токены, компонентное дерево, a11y, тестовые якоря |
| `.planning/phases/phase-05-bento-dashboard/CONTRACT.md` | Контракт UI ↔ `orchestrator.json`: схема, деривация, точки расширения |
| `web/` | Next.js App Router дашборд: `/`, `/email`, `/vacancies`, `/rzhd` |
| `web/lib/orchestrator/` | Загрузчик конфига (`config.ts`), валидация (`schema.ts`), деривация (`derive.ts`), источник (`source.ts`) |
| `web/app/globals.css` | Tailwind v4 CSS-first: `@import "tailwindcss"` + `@theme`-токены |

## Команды запуска (Windows 11, PowerShell)

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r tests\requirements-dev.txt
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe tests\browser_test.py

# Bento-дашборд (Phase 5)
Set-Location web
npm install
npm run dev          # http://127.0.0.1:3000
npm run typecheck
npm run build
Set-Location ..
```

## Журнал изменений документации

| Дата | Изменение |
|------|-----------|
| 26.10.2026 | `docs/architecture.md` → `.planning/ARCHITECTURE.md` |
| 26.10.2026 | `docs/plan.md` → `.planning/PROGRESS.md` (шаги настройки окружения отмечены `[x]`) |
| 26.10.2026 | `docs/memory.md` → `.planning/MEMORY.md` |
| 26.10.2026 | Созданы `.planning/ROADMAP.md`, `.planning/SECURITY.md` |
| 26.10.2026 | Скриншот e2e перенесён в `.planning/screenshots/`, ссылки в конфиге и тесте обновлены |
| 26.10.2026 | Папка `docs/` удалена (содержимое полностью мигрировано) |
