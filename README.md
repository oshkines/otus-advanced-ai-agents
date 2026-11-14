# web/ — AI Dev Navigator (bento dashboard)

**🌐 Рабочий стенд (Live Demo):** [Дашборд](http://82.148.236.43:3000) | [Обзор MVP](http://82.148.236.43:3000/overview)

Next.js App Router + Tailwind CSS v4. Данные берутся из `../config/orchestrator.json`
(единственный источник истины), русские подписи — из `lib/i18n/ru.ts`.

Спецификация: `.planning/phases/phase-05-bento-dashboard/{DISCUSS,DESIGN,CONTRACT}.md`,
дизайн-система: `design.md` в корне проекта.

## Команды (Windows, PowerShell)

```powershell
Set-Location web
npm install
npm run dev          # http://127.0.0.1:3000
npm run dev:preview  # http://127.0.0.1:3080 — предпросмотр для ревью
npm run build
npm run typecheck    # tsc --noEmit
npm run start:e2e    # порт 3100 — для Playwright Python e2e
npm run start:prod   # next start без фиксированного порта (PORT из окружения)
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `ORCHESTRATOR_CONFIG_PATH` | `../config/orchestrator.json` | путь к конфигу ядра (override) |
| `DASHBOARD_SOURCE` | `file-config` | ветка B: `http-api` |
| `BUILD_STANDALONE` | не задана | `1` → `output: "standalone"` для Docker/TimeWeb |
| `PORT` | `3000` | порт для `start:prod` (TimeWeb Cloud, Vercel — автоматически) |

Секретов фронтенд не использует: `.env` для дашборда не нужен.

## Деплой

*   **Vercel.** Root Directory = `web`. Build `npm run build`, Output — по умолчанию
    (SSR). `/overview` собирается статически, дашборд (`/`, `/email`, `/vacancies`,
    `/rzhd`) — dynamic: `export const dynamic = "force-dynamic"` стоит на layout
    группы `(dashboard)`.
*   **TimeWeb Cloud (Node.js).** Build `npm run build`, Start `npm run start:prod`
    (порт берётся из `PORT`).
*   **TimeWeb Cloud (Docker).** `BUILD_STANDALONE=1 npm run build`, затем
    `node .next/standalone/server.js`; `../config/orchestrator.json` попадает в
    трейс благодаря `outputFileTracingIncludes` в `next.config.ts`.
*   Если конфиг всё же недоступен (например, файл не попал в образ), приложение не
    падает: дашборд показывает баннер `config-error-banner`, навигация строится из
    `DEFAULT_NAVIGATION`, каналы уходят в `not_connected`.

## Структура

```
web/
├── app/
│   ├── (dashboard)/         # route group: URL не содержит скобок
│   │   ├── layout.tsx       # AppShell (sidebar + баннеры), force-dynamic
│   │   ├── page.tsx         # / — bento: Модули (Email, Вакансии, РЖД) + Система
│   │   ├── email/           # /email
│   │   ├── vacancies/       # /vacancies
│   │   └── rzhd/            # /rzhd
│   ├── overview/            # /overview — публичная MVP-витрина (без сайдбара)
│   ├── layout.tsx           # html/body, next/font (latin+cyrillic), MotionProvider
│   └── globals.css          # @import tailwindcss + @theme (палитра, радиусы, motion)
├── components/
│   ├── layout/              # AppShell, Sidebar (client), Topbar, AuroraBackdrop, TrimaxionPassage (GSAP)
│   ├── bento/               # BentoGrid, BentoCard (motion), Metric, EmptyState
│   ├── brand/               # TrimaxionMark (логотип), TrimaxionShip (силуэт для пасхалки)
│   ├── cards/               # CoreCard, HealthCard, WorkersCard, StorageCard, E2ECard, ChannelCard
│   ├── overview/            # ModuleCard, OverviewCta для /overview
│   ├── providers/           # MotionProvider (MotionConfig reducedMotion="user")
│   ├── ui/                  # Pressable — кнопка с hover/tap-откликом
│   ├── icons.tsx            # единый набор иконок (lucide-react)
│   └── interactive/, states/
└── lib/
    ├── orchestrator/        # types, schema (runtime-валидация), config (fs), derive, status, source, snapshot
    ├── i18n/ru.ts           # подписи по label_key
    ├── mock/                # MOCK-данные каналов (до Phase 6)
    ├── cn.ts
    └── format.ts
```

## Точка расширения до варианта B

- `app/api/dashboard/route.ts` — BFF-эндпоинт, отдающий `DashboardSnapshot`.
- `lib/orchestrator/source.ts` — добавить `httpDashboardSource` и выбирать по `DASHBOARD_SOURCE`.
- `lib/orchestrator/status.ts` — добавить `sqliteStatusProvider` (чтение `data/cache.db`).

Компоненты bento и страницы при переходе на B не переписываются.

