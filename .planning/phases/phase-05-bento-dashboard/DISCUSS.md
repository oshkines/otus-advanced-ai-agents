# DISCUSS: Phase 5 — Bento Dashboard UI (Next.js 15 + Tailwind CSS v4)

> Формат: `/gsd-discuss-phase` (gsd-core: фаза → шаги → `.planning/PROGRESS.md`).
> Дата обсуждения: 01.11.2026. Статус: **согласовано**, переходим к реализации.
> Артефакты фазы: `DISCUSS.md` (этот файл), `DESIGN.md`, `CONTRACT.md`.

---

## 1. Контекст и проблема

Сейчас UI проекта — одномодульная заглушка `src/status_panel.html`: self-contained HTML
с четырьмя карточками, служит целью Тест-маяка 2 (`tests/browser_test.py`, Playwright Python).

Требуется корпоративного вида **bento-дашборд** с левым боковым меню и тремя каналами
(**Email**, **Вакансии**, **РЖД**), который управляется единственным конфигом ядра
`config/orchestrator.json` — то есть состав меню, расписания и статусы не должны быть
захардкожены во фронтенде.

## 2. Входные данные (что реально прочитано)

| Источник | Что взято |
|---|---|
| `config/orchestrator.json` (v0.1.0) | `core`, `workers[]` (`vacancy_scanner`, `telegram_watcher`), `storage.sqlite` (`processed_messages`, `processed_emails`), `ui.status_panel`, `e2e` |
| `.planning/ARCHITECTURE.md` | контракт «ядро ↔ воркер», запрет Node.js в e2e |
| `.planning/SECURITY.md` | секреты только в env, в конфиге только имена переменных |
| `.planning/MEMORY.md` | путь проекта содержит пробелы и кириллицу; консоль Windows cp1251/cp866 |
| `pre-commit.bat` | 3 проверки конфига, ключевая — **запрет кириллицы** в `config/orchestrator.json` |
| `src/status_panel.html` | палитра и структура текущего UI (slate), которую переиспользуем |
| `CLAUDE.md` | строгая типизация, без хардкода секретов, архитектурный план перед кодом |

**Отсутствующие файлы (зафиксировано):** `design.md` и `.clinerules/gsd.md` в проекте
**не существуют**; `.clinerules` — это файл, а не каталог. Роль «gsd-правил» выполняет
`.planning/ROADMAP.md` + `.planning/PROGRESS.md`. Команда `/gsd-discuss-phase` в
`.clinerules` не зарегистрирована (там только `/review` и `/testgen`) — фаза
инициализирована по конвенции gsd-core, описанной в `ROADMAP.md`.

**Окружение:** Node `v24.21.0` (Next.js требует ≥18.18 ✅), Python 3.12.14 в `.venv`,
Playwright Python 1.64.1. `package.json` в проекте отсутствовал — фронтенд создаётся с нуля.

## 3. Жёсткие ограничения фазы

| # | Ограничение | Источник |
|---|---|---|
| 1 | `config/orchestrator.json` — **только ASCII** (русские подписи живут в TS-словаре по `label_key`) | `pre-commit.bat` проверка 2/3, `SECURITY.md` |
| 2 | e2e-раннер — **Playwright for Python**, без собственных Node-тестов | `ARCHITECTURE.md` |
| 3 | Абсолютный путь содержит пробелы и кириллицу → `path.resolve`, никакой строковой склейки | `MEMORY.md` |
| 4 | В конфиг добавляем только **имена** env-переменных (`env_required`), без значений | `SECURITY.md`, `CLAUDE.md` |
| 5 | `.env` не читается агентом; секреты — только из окружения Windows | `.clinerules` |
| 6 | Контракт с C++ core не ломаем: `ui.status_panel` остаётся рабочим | `ARCHITECTURE.md` |
| 7 | Стиль кода — строгая типизация (`strict: true`, явные типы) | `CLAUDE.md` |

## 4. Решения по открытым вопросам (согласованы 01.11.2026)

| # | Вопрос | Решение |
|---|---|---|
| 1 | Нужен ли обзорный корневой пункт меню | **Да.** `/` — общий bento-дашборд; переход в раздел — **кликом по карточке канала**. Sidebar дублирует навигацию для прямых ссылок (deep-link) |
| 2 | Что показывать по Email | На главной — **счётчики и статус** канала; внутри `/email` — **список писем с ИИ-вердиктами** |
| 3 | Что мониторит РЖД | **Свободные места, цены и типы вагонов** на даты каникул Алфёровского вуза |
| 4 | Где живёт фронтенд | Каталог **`web/`** в корне проекта; `node_modules`, `.next`, `out` — в `.gitignore` |
| 5 | Источник статусов | В будущем — **SQLite** (`data/cache.db`), фронтенд читает данные оттуда через серверный слой |
| 6 | Расширять ли `pre-commit.bat` на `web/` | **Нет.** Валидация остаётся только для конфига ядра |

## 5. Выбранный вариант: A — «Config-SSR» (+ точка расширения до B)

Next.js App Router, Server Components читают `config/orchestrator.json` с диска на сервере,
bento-сетка и sidebar строятся из `ui.dashboard.navigation`. Tailwind CSS v4 подключён
CSS-first (`@theme`, без `tailwind.config.js`).

Точка расширения до **варианта B** (BFF + polling) заложена на уровне интерфейсов:

```ts
// web/lib/orchestrator/source.ts
export interface DashboardSource { readonly id: SourceId; load(): Promise<DashboardSnapshot> }

// web/lib/orchestrator/status.ts
export interface StatusProvider { readonly id: string; readStatuses(ids: string[]): Promise<Map<string, WorkerStatus>> }
```

Переход на B = добавить `web/app/api/dashboard/route.ts` + реализацию `httpDashboardSource`
и выбрать источник через переменную окружения `DASHBOARD_SOURCE`; **компоненты bento и
страницы не переписываются**.

## 6. Отвергнутые варианты

| Вариант | Почему отклонён |
|---|---|
| B — «BFF + live polling» | Избыточен, пока нет реальных статусов от C++ core / SQLite: появился бы дублирующий слой с polling-логикой без источника данных |
| C — «Static export (`output: export`)» | Тупик по данным: rebuild на каждое изменение конфига, Route Handlers недоступны, каналы навсегда `not_connected` |

## 7. Out of scope (не делаем в этой фазе)

- Реальные статусы воркеров из SQLite (ждём Phase 2 и Phase 3/6).
- Реализация воркеров `email_watcher.py`, `rzhd_watcher.py` — только **описания** в конфиге, `enabled: false`.
- Авторизация, роли, мультиязычность (только `ru`), переключатель светлой темы.
- Замена `src/status_panel.html` — остаётся UI C++ ядра и целью текущего e2e.
- Скрипт Playwright для нового дашборда — следующий шаг фазы (`tests/browser_test_dashboard.py`).

## 8. Exit criteria

- `npm run build` в `web/` — без ошибок; `npm run typecheck` (`tsc --noEmit`) — чисто.
- Маршруты `/`, `/email`, `/vacancies`, `/rzhd` рендерятся; sidebar строится из `ui.dashboard.navigation`.
- Отсутствие воркера не роняет страницу: карточка/раздел в состоянии `not_connected`.
- `config/orchestrator.json` без кириллицы, `pre-commit.bat` → exit 0.
- Скриншот дашборда в `.planning/screenshots/` (Тест-маяк 3, Playwright Python).

## 9. Риски и митигации

| Риск | Митигация |
|---|---|
| Пробелы/кириллица в пути ломают инструменты | `path.resolve(process.cwd(), "..")` + override через `ORCHESTRATOR_CONFIG_PATH` |
| `next build` не тащит `../config` в трейс | `outputFileTracingIncludes` в `next.config.ts` |
| Воркеров Email/РЖД ещё нет | состояние `not_connected` + бейдж «MOCK», без исключений в рантайме |
| `node_modules` попадает в git | блок Node/Next в `.gitignore` |
| Рассинхрон «конфиг ↔ фронтенд» | один загрузчик (`loadOrchestratorConfig`) + runtime-валидация схемы без внешних зависимостей |

## 10. Следующие шаги

1. Скелет `web/` (эта фаза): конфиг-лоадер, bento, sidebar, 4 маршрута.
2. `tests/browser_test_dashboard.py` — Playwright Python по `http://127.0.0.1:3100` + скриншот.
3. Phase 6: воркеры `email_watcher` и `rzhd_watcher`, наполнение SQLite.
4. Ветка B: `app/api/dashboard/route.ts` + `httpDashboardSource` + polling.

