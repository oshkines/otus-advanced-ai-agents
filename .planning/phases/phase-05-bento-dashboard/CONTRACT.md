# CONTRACT: UI ↔ `config/orchestrator.json` (Phase 5)

> Контракт между единственным конфигом ядра и Next.js-дашбордом.
> Жёсткое требование: **вся кириллица запрещена** в `config/orchestrator.json`
> (`pre-commit.bat`, проверка 2/3) — русские подписи живут во фронтенде.

---

## 1. Принципы

1. `config/orchestrator.json` — **единственный источник истины** для состава меню,
   расписаний, каналов и путей хранения.
2. Конфиг остаётся **ASCII-only**: подписи адресуются ключами (`label_key`), а не текстом.
3. Обратная совместимость: `ui.status_panel`, `storage`, `e2e` не меняются — их читает C++ ядро
   и текущий e2e (`tests/browser_test.py`).
4. Неизвестные поля не ломают фронтенд (forward-compatible), отсутствующие — заполняются
   значениями по умолчанию в слое деривации.
5. Никаких значений секретов: только **имена** переменных в `workers[].env_required`.

## 2. Расширение конфига (проект v0.2.0)

### 2.1 Новая секция `ui.dashboard`

```json
"ui": {
  "status_panel": "src/status_panel.html",
  "auto_open": false,
  "dashboard": {
    "framework": "nextjs-tailwind4",
    "app_dir": "web",
    "refresh_interval_sec": 15,
    "navigation": [
      {
        "id": "email",
        "label_key": "nav.email",
        "icon": "mail",
        "order": 10,
        "worker_ids": ["email_watcher"],
        "storage_table": "processed_emails"
      },
      {
        "id": "vacancies",
        "label_key": "nav.vacancies",
        "icon": "briefcase",
        "order": 20,
        "worker_ids": ["vacancy_scanner"],
        "storage_table": null
      },
      {
        "id": "rzhd",
        "label_key": "nav.rzhd",
        "icon": "train",
        "order": 30,
        "worker_ids": ["rzhd_watcher"],
        "storage_table": null
      }
    ]
  }
}
```

| Поле | Тип | Обязательно | Смысл |
|---|---|---|---|
| `framework` | `string` | нет | маркер стека (`nextjs-tailwind4`), информационное |
| `app_dir` | `string` | нет | каталог фронтенда относительно корня проекта |
| `refresh_interval_sec` | `number` | нет | интервал авто-обновления для ветки B (SSR игнорирует) |
| `navigation[].id` | `string` | да | слаг: используется в URL `/⟨id⟩` и в `data-testid` |
| `navigation[].label_key` | `string` | да | ключ словаря `web/lib/i18n/ru.ts` (`nav.*`) |
| `navigation[].icon` | `string` | нет | имя иконки: `mail` / `briefcase` / `train` / `grid` |
| `navigation[].order` | `number` | нет | порядок в sidebar (по возрастанию) |
| `navigation[].worker_ids` | `string[]` | да | какие воркеры питают канал |
| `navigation[].storage_table` | `string \| null` | нет | таблица SQLite с данными канала |

### 2.2 Новые описания воркеров (только метаданные, `enabled: false`)

```json
{
  "id": "email_watcher",
  "script": "agents/email_watcher.py",
  "interpreter": "python",
  "enabled": false,
  "schedule": "*/10 * * * *",
  "timeout_sec": 120,
  "stdout_format": "json",
  "env_required": ["EMAIL_IMAP_HOST", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASSWORD"],
  "args": []
},
{
  "id": "rzhd_watcher",
  "script": "agents/rzhd_watcher.py",
  "interpreter": "python",
  "enabled": false,
  "schedule": "0 */2 * * *",
  "timeout_sec": 180,
  "stdout_format": "json",
  "env_required": ["RZHD_API_TOKEN"],
  "args": ["--from", "SPB", "--to", "MSK", "--car-types", "coupe,platzkart,sv", "--purpose", "university-holidays"]
}
```

Правила:
- `env_required` — **только имена** переменных; значения берутся из окружения Windows.
- `enabled: true` ставит только владелец проекта после реализации скрипта воркера.
- `args` для `rzhd_watcher` — ASCII-идентификаторы; конкретные даты каникул Алфёровского вуза
  уточняются в Phase 6 и передаются либо через `args`, либо через env (без кириллицы).
- Скриптов `agents/email_watcher.py` и `agents/rzhd_watcher.py` пока **нет** — это Phase 6.

## 3. Модель данных во фронтенде

Файл `web/lib/orchestrator/types.ts` (публичные типы, читаются компонентами):

```ts
export interface OrchestratorConfig {
  version: string;
  core: CoreConfig;
  workers: WorkerConfig[];
  storage: { sqlite: StorageSqliteConfig };
  ui: UiConfig;
  e2e?: E2EConfig;
}

export interface WorkerConfig {
  id: string;
  script: string;
  interpreter: string;
  enabled: boolean;
  schedule: string | null;
  timeout_sec: number;
  stdout_format: string;
  env_required: string[];
  args: string[];
}

export interface NavItemConfig {
  id: string;
  label_key: string;
  icon: string;
  order: number;
  worker_ids: string[];
  storage_table: string | null;
}

export type SectionStatus = "active" | "disabled" | "not_connected";

export interface DashboardNavSection {
  id: string;            // слаг, он же сегмент URL
  label: string;         // резолвнутая подпись из словаря ru
  icon: IconName;        // нормализованное имя иконки
  href: string;          // "/email" | "/vacancies" | "/rzhd"
  workerIds: string[];
  storageTable: string | null;
  workers: WorkerConfig[]; // найденные в конфиге воркеры канала
  status: SectionStatus;
}
```

Типы рантайм-статусов (`web/lib/orchestrator/status.ts`):

```ts
export type WorkerRuntimeStatus = "running" | "idle" | "error" | "unknown";

export interface WorkerStatus {
  workerId: string;
  status: WorkerRuntimeStatus;
  lastRunIso: string | null;
  detail: string | null;
}
```

## 4. Правила деривации (config → UI)

`web/lib/orchestrator/derive.ts`:

1. `navigation` сортируется по `order` (ASC), при равенстве — по `id`.
2. `label` резолвится через `translateLabel(label_key)`; если ключ не найден — используется
   `id` в верхнем регистре (никогда не падаем).
3. `href = "/" + id` (кроме `id === "overview"` → `"/"`).
4. `workers` секции = `config.workers.filter(w => item.worker_ids.includes(w.id))`.
5. `status`:
   - `worker_ids` пуст **или** ни один воркер не найден → `not_connected`;
   - есть найденный воркер с `enabled: true` → `active`;
   - иначе → `disabled`.
6. Если `ui.dashboard` или `navigation` отсутствуют — применяется `DEFAULT_NAVIGATION`
   (Email / Вакансии / РЖД), т.е. дашборд работает с конфигом v0.1.0.
7. `refresh_interval_sec` по умолчанию `15`.

## 5. Переменные окружения фронтенда

| Переменная | Обязательна | Назначение |
|---|---|---|
| `ORCHESTRATOR_CONFIG_PATH` | нет | абсолютный/относительный путь к `orchestrator.json`; по умолчанию `../config/orchestrator.json` от `web/` |
| `DASHBOARD_SOURCE` | нет | `file-config` (по умолчанию, вариант A) \| `http-api` (ветка B) |

Секретов фронтенд не читает: `.env` для UI **не нужен**, токены остаются у воркеров.

## 6. Точки расширения

### 6.1 До варианта B (BFF + live)

```
web/app/api/dashboard/route.ts     # GET: DashboardSnapshot в JSON (без секретов)
web/lib/orchestrator/source.ts     # + httpDashboardSource → fetch("/api/dashboard")
web/lib/orchestrator/config.ts     # getDashboardSource() читает DASHBOARD_SOURCE
```

Контракт ответа API = сериализованный `DashboardSnapshot`:

```ts
interface DashboardSnapshot {
  sourceId: "file-config" | "http-api";
  generatedAtIso: string;
  configPath: string | null;
  config: OrchestratorConfig | null;
  nav: DashboardNavSection[];
  statuses: Record<string, WorkerStatus>;
  error: string | null;          // текст ошибки конфига для баннера
}
```

### 6.2 До реальных статусов из SQLite

`StatusProvider` (см. `web/lib/orchestrator/status.ts`) сейчас реализован как
`nullStatusProvider` (все воркеры → `unknown`). Реальная реализация появится как серверный
провайдер `sqliteStatusProvider`, читающий `storage.sqlite.path` (`data/cache.db`) —
вызывается только из Server Component или Route Handler, никогда из браузера.

## 7. Правила совместимости и проверки

| Проверка | Как выполняется |
|---|---|
| ASCII-only конфиг | `pre-commit.bat` (проверка 2/3) → exit 0 |
| Валидный JSON / UTF-8 | `pre-commit.bat` (проверка 3/3) |
| Схема конфига во фронтенде | `parseOrchestratorConfig()` → `ConfigValidationError` с перечнем полей |
| Обратная совместимость | отсутствующий `ui.dashboard` → `DEFAULT_NAVIGATION` |
| C++ контракт | `ui.status_panel`, `storage`, `e2e` не изменяются по смыслу |
| TypeScript | `npm run typecheck` (`tsc --noEmit`) |

## 8. Версионирование

- Конфиг: `version` → `"0.2.0"` (аддитивное расширение, обратная совместимость сохранена).
- При удалении/переименовании поля — повышение major и запись в раздел «Журнал» этого файла.

| Дата | Изменение |
|---|---|
| 01.11.2026 | Создан контракт: `ui.dashboard.navigation`, воркеры `email_watcher` / `rzhd_watcher`, `DashboardSnapshot` |
