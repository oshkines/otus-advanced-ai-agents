# DESIGN: Bento Dashboard (Phase 5)

> Визуальная и компонентная спецификация дашборда. Источник дизайн-решений — раздел 4
> `DISCUSS.md`. Все цифры сетки соответствуют Tailwind CSS v4 (12-колоночная сетка).

---

## 1. Каркас экрана

```
┌───────────────┬──────────────────────────────────────────────────────────────┐
│  SIDEBAR      │  TOPBAR: название канала · StatusBadge · кнопка обновления    │
│  (18rem)      ├──────────────────────────────────────────────────────────────┤
│  • Обзор      │                                                              │
│  • Email      │            BENTO GRID  (grid-cols-12, gap-4)                 │
│  • Вакансии   │                                                              │
│  • РЖД        │                                                              │
│  ─────────    │                                                              │
│  core: v0.1.0 │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

- Контейнер: `min-h-screen`, `bg-canvas`, `text-ink`, шрифт `Segoe UI, Tahoma, sans-serif`
  (консистентно с `src/status_panel.html`).
- Sidebar фиксированный на `lg`, на мобильных схлопывается в верхнюю полосу со скроллом.
- Основная область: `p-4 lg:p-6`, ограничение `max-w-[1600px]`.

## 2. Дизайн-токены (Tailwind v4, CSS-first)

`web/app/globals.css`:

| CSS-переменная `@theme` | Значение | Утилита | Назначение |
|---|---|---|---|
| `--color-canvas` | `#0f172a` | `bg-canvas` | фон приложения |
| `--color-panel` | `#1e293b` | `bg-panel` | фон bento-карточки |
| `--color-panel-hover` | `#243044` | `bg-panel-hover` | hover карточки-ссылки |
| `--color-line` | `#334155` | `border-line` | границы, разделители |
| `--color-ink` | `#e2e8f0` | `text-ink` | основной текст |
| `--color-muted` | `#94a3b8` | `text-muted` | вторичный текст |
| `--color-ok` | `#22c55e` | `text-ok` | «всё хорошо» / running |
| `--color-warn` | `#f59e0b` | `text-warn` | предупреждение |
| `--color-danger` | `#ef4444` | `text-danger` | ошибка |
| `--color-idle` | `#64748b` | `text-idle` | выключено / `not_connected` |
| `--radius-bento` | `1rem` | `rounded-bento` | радиус карточек |
| `--font-mono` | `Consolas, "Courier New", monospace` | `font-mono` | значения, пути, JSON |

Палитра перенесена из заглушки `src/status_panel.html` → визуальная преемственность.

> `tailwind.config.js` **не создаётся**: в Tailwind v4 тема задаётся директивой `@theme`
> в CSS, PostCSS-плагин — `@tailwindcss/postcss` (см. `web/postcss.config.mjs`).

## 3. Bento-сетка

- Базовая сетка: `grid grid-cols-12 gap-4 auto-rows-[minmax(7.5rem,auto)]`.
- Мобильный (`< 640px`): все карточки `col-span-12`.
- `md` (≥768px): промежуточные `col-span`.
- `lg` (≥1024px): полная bento-раскладка.

### 3.1 Страница `/` (Обзор)

| Карточка | `col-span` (lg) | `row-span` | Содержимое |
|---|---|---|---|
| Core hero | `6` | `2` | `core.name`, `runtime`, `target_platform`, `tick_interval_sec`, `timezone`, версия конфига |
| Health | `3` | `1` | агрегат по `workers[].enabled` + число `not_connected` |
| Workers | `3` | `2` | список `workers[]`: `id`, `schedule`, `timeout_sec`, состояние (read-only) |
| Channel: Email | `4` | `1` | счётчики (всего / с ИИ-вердиктом) + статус; **ссылка на `/email`** |
| Channel: Вакансии | `4` | `1` | число вакансий по тегам + статус; **ссылка на `/vacancies`** |
| Channel: РЖД | `4` | `1` | ближайшая дата поездки, свободных мест, цена от + статус; **ссылка на `/rzhd`** |
| Storage | `6` | `1` | `storage.sqlite.path`, `dedup_window_days`, `tables[]` |
| E2E / MCP | `6` | `1` | `e2e.runner`, `e2e.test_script`, `ui.status_panel` |

### 3.2 `/email`
Заголовок канала + счётчики (3 мини-карточки: всего / требуют ответа / отклонено),
затем список писем: отправитель, тема, время, **ИИ-вердикт** (`apply` / `review` / `ignore` /
`spam`) в виде цветного бейджа + краткое обоснование. Данные — заглушка до появления `email_watcher`.

### 3.3 `/vacancies`
Счётчики по тегам из `workers[vacancy_scanner].args` (`C++`, `1C`, `Remote`), затем карточки
вакансий: компания, стек, зарплатная вилка, источник, дата. Данные — заглушка.

### 3.4 `/rzhd`
Предмет мониторинга: **свободные места, цены, типы вагонов** на даты каникул Алфёровского вуза.
Карточки-рейсы: направление, дата, поезд, тип вагона (`coupe` / `platzkart` / `sv`),
свободных мест, цена, тренд цены. Данные — заглушка до появления `rzhd_watcher`.

## 4. Компонентное дерево

```
web/
├── app/
│   ├── layout.tsx                 # html/body + AppShell (nav из конфига)
│   ├── page.tsx                   # Обзор: bento из конфига
│   ├── email/page.tsx             # канал Email
│   ├── vacancies/page.tsx         # канал Вакансии
│   ├── rzhd/page.tsx              # канал РЖД
│   ├── api/dashboard/route.ts     # (ветка B) BFF-эндпоинт, пока не создан
│   └── globals.css                # @import "tailwindcss" + @theme
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx           # sidebar + topbar + content
│   │   ├── Sidebar.tsx            # client: active link через usePathname
│   │   ├── Topbar.tsx             # заголовок канала + StatusBadge
│   │   ├── SectionHeader.tsx      # h1 раздела + статус + баннер-заглушка
│   │   └── StatusBadge.tsx        # active | disabled | not_connected | error
│   ├── bento/
│   │   ├── BentoGrid.tsx          # сетка 12 колонок
│   │   ├── BentoCard.tsx          # базовая карточка (опционально <Link>)
│   │   └── Metric.tsx             # label + value + tone
│   ├── cards/
│   │   ├── CoreCard.tsx
│   │   ├── HealthCard.tsx
│   │   ├── WorkersCard.tsx
│   │   ├── StorageCard.tsx
│   │   ├── E2ECard.tsx
│   │   └── ChannelCard.tsx        # карточка канала-ссылки (Email/Вакансии/РЖД)
│   └── icons.tsx                  # инлайн-SVG, без внешних иконных пакетов
└── lib/
    ├── cn.ts                      # склейка className-ов
    ├── i18n/ru.ts                 # подписи (label_key -> строка)
    ├── orchestrator/*             # конфиг-лоадер, типы, схема, деривация (см. CONTRACT.md)
    └── mock/*                     # заглушки данных каналов (явно помечены MOCK)
```

## 5. Состояния и статусы

| Состояние | Визуал | Условие |
|---|---|---|
| `active` | зелёная точка + `text-ok` | есть найденный воркер с `enabled: true` |
| `disabled` | серая точка + `text-idle` | воркер описан, но `enabled: false` |
| `not_connected` | янтарная точка + `text-warn` | `worker_ids` не найдены среди `workers[]` |
| `config_error` | красный баннер | конфиг не прочитан / не прошёл валидацию |

`not_connected` — обязательное состояние для Email и РЖД на старте: страница **рендерится**,
данные-заглушки помечены бейджем «MOCK».

## 6. Доступность (a11y)

- Sidebar — `<nav aria-label="Основная навигация">`, активный пункт `aria-current="page"`.
- Статус — `role="status"` и текстовое значение (не только цвет).
- Карточки-ссылки — реальная ссылка (`<Link>`/`<a>`), фокус-кольцо `focus-visible:ring-2`.
- Контраст `text-muted` на `bg-panel` ≥ 4.5:1 (slate-400 на slate-800).

## 7. Тестовые якоря (для Playwright Python, следующий шаг)

| `data-testid` | Элемент |
|---|---|
| `app-sidebar` | `<nav>` сайдбара |
| `nav-item-<id>` | пункт меню (`overview`, `email`, `vacancies`, `rzhd`) |
| `bento-grid` | корневая bento-сетка |
| `core-card`, `workers-card`, `storage-card`, `e2e-card` | карточки обзора |
| `channel-card-<id>` | карточка канала на обзоре |
| `config-error-banner` | баннер ошибки конфига |
| `status-badge` | индикатор статуса канала |

