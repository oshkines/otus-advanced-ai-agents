# web/ — AI Dev Navigator (bento dashboard)

Next.js App Router + Tailwind CSS v4. Данные берутся из `../config/orchestrator.json`
(единственный источник истины), русские подписи — из `lib/i18n/ru.ts`.

Спецификация: `.planning/phases/phase-05-bento-dashboard/{DISCUSS,DESIGN,CONTRACT}.md`.

## Команды (Windows, PowerShell)

```powershell
Set-Location web
npm install
npm run dev        # http://127.0.0.1:3000
npm run build
npm run typecheck  # tsc --noEmit
npm run start:e2e  # порт 3100 — для Playwright Python e2e
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `ORCHESTRATOR_CONFIG_PATH` | `../config/orchestrator.json` | путь к конфигу ядра (override) |
| `DASHBOARD_SOURCE` | `file-config` | ветка B: `http-api` |

Секретов фронтенд не использует: `.env` для дашборда не нужен.

## Структура

```
web/
├── app/
│   ├── (dashboard)/         # route group: URL не содержит скобок
│   │   ├── page.tsx         # / — bento: Модули (Email, Вакансии, РЖД) + Система
│   │   ├── email/           # /email
│   │   ├── vacancies/       # /vacancies
│   │   └── rzhd/            # /rzhd
│   ├── layout.tsx           # html/body + AppShell (nav из конфига)
│   └── globals.css          # @import tailwindcss + @theme (палитра design.md)
├── components/layout/       # AppShell, Sidebar (client), Topbar, SectionTitle, SectionHeader, StatusBadge, AuroraBackdrop
├── components/bento/        # BentoGrid, BentoCard, Metric, EmptyState
├── components/cards/        # CoreCard, HealthCard, WorkersCard, StorageCard, E2ECard, ChannelCard
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
