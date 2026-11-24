# API-спецификация — AI Dev Navigator Backend (FastAPI)

> Версия: 1.0 · Дата: 23.11.2026 · Статус: реализовано (`api/main.py`), тесты — `tests/test_api_tdd.py`
> Связанные артефакты: `db/migrations/001_init_schema.sql`, `db/migrations/002_tighten_worker_grants.sql`,
> `architecture.md` §7 (LLM Structured Output), `agents/mail_worker.py` (каскад DeepSeek), `web/` (потребитель API).

## 1. Назначение и рамки

REST-API — единственная точка доступа фронтенда Next.js (`web/`) к PostgreSQL (`ai_dev_navigator`).
Сервис отдаёт агрегаты для Bento-карточек дашборда, CRUD по доменным сущностям и AI-фичу
классификации с сохранением результата в БД.

| Параметр | Значение |
|---|---|
| Фреймворк | FastAPI 0.165 (Pydantic v2, Starlette) |
| ASGI-сервер | uvicorn, порт **8000** (`http://127.0.0.1:8000`) |
| Префикс API | `/api/v1` |
| Swagger UI | `http://127.0.0.1:8000/docs` |
| OpenAPI JSON | `http://127.0.0.1:8000/openapi.json` (ReDoc — `/redoc`) |
| Драйвер БД | `asyncpg` (пул `1..5` соединений, роль `navigator_worker` + RLS) |
| LLM | DeepSeek (`https://api.deepseek.com`) или OpenRouter (`https://openrouter.ai/api/v1`) |
| Запуск | `.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000` |

### 1.1. CORS

Фронтенд живёт на порту `3000` (локально и на стенде `82.148.236.43`), поэтому origin-список
задаётся явно (никаких `*` — иначе браузер отклонит запросы с credentials):

```text
API_CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://82.148.236.43:3000
```

Значение из `.env` **дополняет** дефолтный список (`DEFAULT_CORS_ORIGINS` в `api/main.py`),
а не заменяет его. Разрешены методы `GET, POST, PATCH, DELETE, OPTIONS`, заголовки — любые,
`max_age=600`. Preflight `OPTIONS` обрабатывается middleware, авторизации в MVP нет.

### 1.2. Конфигурация (`.env`)

| Переменная | Назначение | Обязательна |
|---|---|---|
| `DATABASE_URL` | DSN роли `navigator_worker` (RLS: только активные ящики) | да (иначе `database.status=unavailable`) |
| `API_CORS_ORIGINS` | Дополнительные origin'ы фронтенда через запятую | нет |
| `LLM_PROVIDER` | `deepseek` (по умолчанию) или `openrouter` | нет |
| `ENV_DEEPSEEK_API_KEY` | Ключ DeepSeek (имя переменной уже используется воркером) | да для AI-фичи |
| `OPENROUTER_API_KEY` | Ключ OpenRouter (если `LLM_PROVIDER=openrouter`) | нет |
| `LLM_BASE_URL` | Переопределение base URL провайдера | нет |
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | Дефолтные модели, если строки в `ai_instructions` нет | нет |

Секреты в логи не попадают: DSN печатается в маскированном виде (`mask_dsn`), ключи — никогда.

## 2. Общие соглашения

### 2.1. Формат данных

* Только JSON (`Content-Type: application/json`), даты — ISO-8601 UTC (`2026-11-23T09:00:00+00:00`),
  даты без времени — `YYYY-MM-DD`.
* Денежные суммы — числа с плавающей точкой в рублях (`NUMERIC(10,2)` → `float`).
* Лишние поля во входных моделях запрещены (`extra="forbid"` → `422`), в ответах LLM — отбрасываются.
* `null` допустим для всех необязательных полей; отсутствие поля в `PATCH` = «не менять».

### 2.2. Конверт ошибок

Доменные ошибки (404/502/503) возвращаются в единой форме:

```json
{"detail": {"code": "db_unavailable", "message": "PostgreSQL недоступна: connection refused"}}
```

| HTTP | `code` | Причина |
|---|---|---|
| 404 | `not_found` | Строки с таким `id` нет (или её скрывает RLS) |
| 422 | — (FastAPI default) | Нарушение Pydantic-схемы: `[{"loc": [...], "msg": ..., "type": ...}]` |
| 502 | `llm_unavailable` | Основная и резервная модели не ответили (таймаут/5xx/битый JSON) |
| 503 | `db_unavailable` | Пул не создан, БД недоступна, `asyncpg` бросил исключение |
| 500 | `internal_error` | Непредвиденная ошибка (детали — в логе сервера, не в ответе) |

`422` оставлен в «родном» формате FastAPI: его генерирует валидатор до входа в обработчик,
и переупаковка сломала бы машинную обработку на фронтенде.

### 2.3. RLS и least privilege (влияет на контракт)

API работает **той же ролью**, что и воркеры (`navigator_worker`), поэтому:

* `mail_accounts` — только `SELECT` + `UPDATE (last_sync_at, last_error, updated_at)`;
* `emails`, `valuable_spam`, `vacancies`, `rzhd_tickets` — `SELECT/INSERT/UPDATE` (без `DELETE`);
* `mail_folders` — полный CRUD;
* политика `vacancies_worker_active` запрещает `status = 'archived'` (`WITH CHECK`), поэтому
  `DELETE /vacancies/{id}` реализован как **мягкое скрытие** (`is_ignored = TRUE`), а не физическое удаление.

### 2.4. Хранение API-атрибутов без DDL

Роль API не владелец схемы (`has_schema_privilege('public','CREATE') = false`), поэтому добавлять
колонки рантаймом нельзя. Две UI-сущности хранятся в существующих «расширяемых» полях:

| API-поле | Где хранится | Чтение в SQL |
|---|---|---|
| `vacancies.is_ignored` | `vacancies.raw -> 'api' ->> 'is_ignored'` | `COALESCE((raw->'api'->>'is_ignored') IN ('true','t','1','yes'), FALSE)` |
| `vacancies.work_format` | `vacancies.raw -> 'api' ->> 'work_format'` | `NULLIF(lower(raw->'api'->>'work_format'), '')` |
| `mail_folders.scan_mode` | токен `NAV_SCAN:<mode>` в `mail_folders.flags TEXT[]` | разбор на стороне Python |

`raw` — штатная колонка «сырых данных источника», `flags` — штатный `TEXT[]` IMAP-флагов;
токены с префиксом `NAV_` принадлежат API, остальные — серверу IMAP. Такое решение сохраняет
least privilege и не требует миграции. Если владелец БД позже добавит нативные колонки (§8.5),
контракт API не изменится, а переключение SQL локализовано в `_vacancy_columns` (выражения
`WORK_FORMAT_SQL` / `IGNORED_SQL`) и `derive_scan_mode`.
## 3. Pydantic-модели (контракт)

Модели объявлены в `api/main.py`; ниже — их нормативный вид. Все модели — Pydantic v2.

### 3.1. Системные

```python
class DatabaseHealth(BaseModel):
    status: Literal["ok", "unavailable"]
    latency_ms: int | None = None          # SELECT 1, округление до мс
    pool_size: int | None = None
    pool_free: int | None = None
    target: str | None = None              # mask_dsn(DATABASE_URL)

class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    generated_at: datetime
    database: DatabaseHealth
    ai: AiProviderHealth

class AiProviderHealth(BaseModel):
    provider: Literal["deepseek", "openrouter"]
    base_url: str
    ready: bool                            # найден ли API-ключ в окружении
    model: str                             # основная модель классификатора
    fallback_model: str
```

### 3.2. Дашборд

```python
class MailSummary(BaseModel):
    accounts: int
    folders_synced: int
    folders_watched: int                   # is_selectable = TRUE
    folders_skipped: int                   # scan_mode = "skip"
    emails_total: int
    emails_new: int                        # status = "new"
    emails_classified: int                 # status = "classified"
    last_sync_at: datetime | None

class TagCount(BaseModel):
    tag: str
    count: int

class ValuableSpamItem(BaseModel):
    id: int
    spam_tag: str | None
    spam_url: str | None
    summary: str
    sender: str
    subject: str
    received_at: datetime

class ValuableSpamSummary(BaseModel):
    total: int
    last_7_days: int
    top_tags: list[TagCount]               # [{"tag": "promo", "count": 3}], до 5 тегов
    latest: list[ValuableSpamItem]         # последние 3 записи, created_at DESC

class VacancySummary(BaseModel):
    total: int
    active: int                            # status IN ("new","viewed") AND NOT is_ignored
    ignored: int
    by_work_format: dict[str, int]         # remote / hybrid / office / unknown
    last_published_at: datetime | None

class RzhdSummary(BaseModel):
    total: int
    watching: int
    available: int                         # status = "available" OR seats_available > 0
    booked: int
    nearest_travel_date: date | None
    cheapest_price_rub: float | None

class AiSummary(BaseModel):
    classifier_model: str | None
    fallback_model: str | None
    max_tokens: int | None
    instructions_active: int

class DashboardSummary(BaseModel):
    generated_at: datetime
    database: DatabaseHealth
    mail: MailSummary
    valuable_spam: ValuableSpamSummary
    vacancies: VacancySummary
    rzhd: RzhdSummary
    ai: AiSummary
```
### 3.3. Почтовые папки

```python
ScanMode = Literal["full", "headers", "skip"]   # полное тело / только заголовки / не сканировать

class MailFolder(BaseModel):
    id: int
    account_id: int
    name: str
    raw_name: str | None                     # сырой IMAP-путь (modified UTF-7)
    special_use: str | None
    is_selectable: bool
    scan_mode: ScanMode
    unread_count: int
    message_count: int
    last_synced_at: datetime

class MailFolderPatch(BaseModel):                  # extra="forbid"
    is_selectable: bool | None = None
    scan_mode: ScanMode | None = None
    # хотя бы одно поле обязательно -> иначе 422

class MailFolderList(BaseModel):
    items: list[MailFolder]
    total: int

class FolderSyncResult(BaseModel):
    status: Literal["ok", "partial", "error"]      # итог POST /mail/sync-folders
    exit_code: int
    folders_saved: int | None
    failures: int
    folders_total: int
    duration_ms: int
    detail: str | None
```

### 3.4. Вакансии

```python
WorkFormat = Literal["remote", "hybrid", "office"]
VacancyStatus = Literal["new", "viewed", "applied", "rejected"]

class Vacancy(BaseModel):
    id: int
    source: str
    external_id: str
    title: str
    company: str
    stack: list[str]
    tags: list[str]
    salary_min: float | None
    salary_max: float | None
    currency: str
    url: str | None
    published_at: datetime | None
    status: VacancyStatus
    score: int | None
    work_format: WorkFormat | None
    is_ignored: bool
    created_at: datetime
    updated_at: datetime

class VacancyCreate(BaseModel):                 # extra="forbid"
    source: str = Field(min_length=1, max_length=64)
    external_id: str | None = None              # None -> sha1(source|title|url)
    title: str = Field(min_length=1, max_length=300)
    company: str = ""
    stack: list[str] = []
    tags: list[str] = []
    salary_min: float | None = Field(default=None, ge=0)
    salary_max: float | None = Field(default=None, ge=0)
    currency: str = Field(default="RUB", max_length=8)
    url: str | None = None                      # только http(s)
    published_at: datetime | None = None
    status: VacancyStatus = "new"
    score: int | None = Field(default=None, ge=0, le=100)
    work_format: WorkFormat | None = None
    is_ignored: bool = False
    description: str | None = Field(default=None, max_length=20000)   # в raw.api.description
    # salary_max >= salary_min -> иначе 422

class VacancyPatch(BaseModel):                  # extra="forbid", хотя бы одно поле
    status: VacancyStatus | None = None
    is_ignored: bool | None = None
    work_format: WorkFormat | None = None
    score: int | None = Field(default=None, ge=0, le=100)
    url: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    company: str | None = None

class VacancyList(BaseModel):
    items: list[Vacancy]
    total: int
    limit: int
    offset: int
```

### 3.5. Билеты РЖД

```python
CarType = Literal["coupe", "platzkart", "sv", "sitting", "luxury"]
TicketStatus = Literal["watching", "available", "booked", "expired", "cancelled"]

class RzhdTicket(BaseModel):
    id: int
    direction_from: str
    direction_to: str
    travel_date: date
    train_number: str
    car_type: CarType
    seats_available: int
    price_rub: float | None
    booking_url: str | None
    status: TicketStatus
    passenger_name: str | None
    trip_window_start: date | None
    trip_window_end: date | None
    notified_at: datetime | None
    created_at: datetime
    updated_at: datetime

class RzhdTicketCreate(BaseModel):              # extra="forbid"
    direction_from: str = Field(min_length=1, max_length=120)
    direction_to: str = Field(min_length=1, max_length=120)
    travel_date: date
    train_number: str = Field(default="", max_length=32)
    car_type: CarType
    seats_available: int = Field(default=0, ge=0)
    price_rub: float | None = Field(default=None, ge=0)
    booking_url: str | None = None              # только http(s)
    status: TicketStatus = "watching"
    passenger_name: str | None = Field(default=None, max_length=120)
    trip_window_start: date | None = None
    trip_window_end: date | None = None         # end >= start -> иначе 422
    raw: dict[str, Any] | None = None

class RzhdTicketList(BaseModel):
    items: list[RzhdTicket]
    total: int
```
### 3.6. AI-классификация

```python
Category = Literal["WHITELIST", "CRITICAL", "VACANCY", "SPAM_VALUABLE", "SPAM"]

class AiClassification(BaseModel):
    """Строгий Structured Output модели (схема = JSON Schema в §5.2)."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    category: Category
    summary: str = ""                          # 1-2 предложения по-русски, <= 600 символов
    spam_tag: str | None = None                # promo / sale / coupon, <= 64 символов
    spam_url: str | None = None                # только http(s), иначе None
    work_format: WorkFormat | None = None      # заполняет только kind="vacancy"
    # priority — computed_field: WHITELIST|CRITICAL|VACANCY|SPAM_VALUABLE -> "HIGH", SPAM -> "LOW"

class ClassifyPreviewRequest(BaseModel):       # extra="forbid"
    kind: Literal["email", "vacancy"] = "email"
    text: str = Field(min_length=1, max_length=20000)     # тело письма / описание вакансии
    subject: str = Field(default="", max_length=400)
    sender: str = Field(default="", max_length=400)
    sender_name: str = Field(default="", max_length=200)
    vacancy_title: str = Field(default="", max_length=300)
    company: str = Field(default="", max_length=300)
    url: str | None = None
    stack: list[str] = []
    salary_min: float | None = Field(default=None, ge=0)
    salary_max: float | None = Field(default=None, ge=0)
    account_id: int | None = None              # None -> первый активный ящик (RLS)
    external_id: str | None = None             # None -> sha1(sender|subject|received_at)
    received_at: datetime | None = None        # None -> now(UTC)
    persist: bool = True                       # False -> «сухой» прогон без записи в БД
    # kind="email"   -> text обязателен (тема/отправитель опциональны)
    # kind="vacancy" -> vacancy_title обязателен (или непустой subject)

class AiRun(BaseModel):
    provider: Literal["deepseek", "openrouter"]
    model: str                                 # основная модель из ai_instructions
    used_model: str                            # фактически ответившая модель
    fallback_model: str
    fallback_used: bool
    attempts: int                              # сколько запросов к LLM сделано
    max_tokens: int                            # бюджет из ai_instructions (кап 1024)
    temperature: float
    timeout_sec: float
    latency_ms: int
    json_mode: bool

class PersistedRecords(BaseModel):
    email_id: int | None = None
    valuable_spam_id: int | None = None
    vacancy_id: int | None = None

class ClassifyPreviewResponse(BaseModel):
    kind: Literal["email", "vacancy"]
    classification: AiClassification
    ai: AiRun
    persisted: PersistedRecords
```

### 3.7. Лента писем

```python
EmailStatus = Literal["new", "classified", "notified", "ignored", "deleted", "error"]

class EmailItem(BaseModel):
    id: int
    account_id: int
    folder_id: int | None                    # NULL — письмо вне известной папки
    folder_name: str | None                  # из LEFT JOIN mail_folders
    message_id: str | None
    external_id: str                         # дедупликация IMAP (Message-ID)
    sender: str
    sender_name: str
    subject: str
    received_at: datetime
    category: Category | None                # вердикт ИИ (те же 5 значений §3.6)
    priority: Literal["HIGH", "LOW"] | None
    ai_summary: str | None                   # emails.summary
    spam_tag: str | None
    spam_url: str | None
    status: EmailStatus
    is_seen: bool
    is_deleted: bool
    ai_model: str | None
    error_text: str | None
    processed_at: datetime | None
    created_at: datetime

class EmailList(BaseModel):
    items: list[EmailItem]
    total: int                               # сколько пришло в ответе
    limit: int
```
## 4. Эндпоинты

### 4.1. `GET /api/v1/health`

Проверка живости сервиса. Всегда `200`, даже если БД лежит (`status = "degraded"`) — чтобы
мониторинг видел сам сервис, а не только его зависимость.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "generated_at": "2026-11-23T10:15:03.412+00:00",
  "database": {"status": "ok", "latency_ms": 12, "pool_size": 1, "pool_free": 1, "target": "82.148.236.43:5432/ai_dev_navigator"},
  "ai": {"provider": "deepseek", "base_url": "https://api.deepseek.com", "ready": true,
         "model": "deepseek-chat", "fallback_model": "deepseek-reasoner"}
}
```

### 4.2. `GET /api/v1/dashboard/summary`

Агрегированная сводка для Bento-карточек: один запрос вместо 7. Все счётчики считаются SQL-агрегатами
под RLS (`navigator_worker` видит только активные ящики и неархивные вакансии).

```json
{
  "generated_at": "2026-11-23T10:15:03.412+00:00",
  "database": {"status": "ok", "latency_ms": 12, "pool_size": 1, "pool_free": 1, "target": "82.148.236.43:5432/ai_dev_navigator"},
  "mail": {"accounts": 1, "folders_synced": 19, "folders_watched": 19, "folders_skipped": 0,
           "emails_total": 0, "emails_new": 0, "emails_classified": 0, "last_sync_at": null},
  "valuable_spam": {"total": 0, "last_7_days": 0, "top_tags": [], "latest": []},
  "vacancies": {"total": 0, "active": 0, "ignored": 0,
                "by_work_format": {"remote": 0, "hybrid": 0, "office": 0, "unknown": 0},
                "last_published_at": null},
  "rzhd": {"total": 0, "watching": 0, "available": 0, "booked": 0,
           "nearest_travel_date": null, "cheapest_price_rub": null},
  "ai": {"classifier_model": "deepseek-chat", "fallback_model": "deepseek-reasoner",
         "max_tokens": 400, "instructions_active": 2}
}
```

| Код | Когда |
|---|---|
| 200 | Сводка собрана |
| 503 | `db_unavailable` — пул не создан, БД не ответила или `asyncpg` бросил исключение |

### 4.3. `GET /api/v1/mail/folders`

Снимок папок IMAP (`mail_folders`) с вычисленным `scan_mode`.

| Query | Тип | Описание |
|---|---|---|
| `account_id` | int ≥ 1 | Фильтр по ящику |
| `scan_mode` | `full\|headers\|skip` | Фильтр по вычисленному режиму |
| `is_selectable` | bool | Только выбранные (`true`) или исключённые (`false`) папки |

```json
{"items": [{"id": 12, "account_id": 1, "name": "INBOX", "raw_name": "INBOX",
            "special_use": "\\Inbox",
            "is_selectable": true, "scan_mode": "full", "unread_count": 3,
            "message_count": 1042, "last_synced_at": "2026-11-23T09:58:11+00:00"}],
 "total": 1}
```

Ошибки: `503 db_unavailable`.

### 4.4. `PATCH /api/v1/mail/folders/{folder_id}`

Обновление режима сканирования и выбора папки. Чтение-изменение-запись выполняется в одной
транзакции (`SELECT ... FOR UPDATE`), IMAP-флаги папки сохраняются, токен `NAV_SCAN:*` заменяется.

```http
PATCH /api/v1/mail/folders/12
{"scan_mode": "headers", "is_selectable": true}
```

| Код | Когда |
|---|---|
| 200 | Обновлённая `MailFolder` |
| 404 | `not_found` — папки нет (или она вне RLS-видимости) |
| 422 | `scan_mode` вне перечня, пустое тело, лишние поля |

### 4.5. `GET /api/v1/vacancies`

| Query | Тип | Описание |
|---|---|---|
| `status` | `new\|viewed\|applied\|rejected` | Статус |
| `work_format` | `remote\|hybrid\|office` | Формат работы |
| `is_ignored` | bool | `false` — только активные, `true` — игнорируемые |
| `q` | str ≤ 120 | Поиск по `title`/`company` (ILIKE) |
| `limit` | 1..200, по умолчанию 50 | Размер страницы |
| `offset` | ≥ 0, по умолчанию 0 | Смещение |

```json
{"items": [{"id": 7, "source": "hh.ru", "external_id": "42", "title": "C++ Developer",
            "company": "AlferSoft", "stack": ["C++20"], "tags": ["remote"],
            "salary_min": 180000.0, "salary_max": 240000.0, "currency": "RUB",
            "url": "https://hh.ru/vacancy/42", "published_at": "2026-11-20T08:00:00+00:00",
            "status": "new", "score": 88, "work_format": "remote", "is_ignored": false,
            "created_at": "2026-11-20T08:01:00+00:00", "updated_at": "2026-11-20T08:01:00+00:00"}],
 "total": 1, "limit": 50, "offset": 0}
```

Сортировка — `published_at DESC NULLS LAST, id DESC` (свежие сверху, детерминированно при равенстве).
### 4.6. `POST /api/v1/vacancies`

Идемпотентная вставка (UPSERT по `UNIQUE (source, external_id)`): повторный POST того же
предложения обновляет поля и **не плодит дубли** — так же работает `agents/vacancy_scanner.py`.

```http
POST /api/v1/vacancies
{"source": "hh.ru", "external_id": "42", "title": "C++ Developer", "company": "AlferSoft",
 "stack": ["C++20"], "salary_min": 180000, "salary_max": 240000,
 "url": "https://hh.ru/vacancy/42", "work_format": "remote", "is_ignored": false}
```

| Код | Когда |
|---|---|
| 201 | Строка создана (ответ — `Vacancy`) |
| 200 | Строка уже была — обновлена (`Vacancy` с новыми полями) |
| 422 | Нет `title`/`source`, `salary_max < salary_min`, `work_format` вне перечня, `extra` поля |
| 503 | `db_unavailable` |

### 4.7. `PATCH /api/v1/vacancies/{vacancy_id}`

Управление игнором по формату работы: `{"work_format": "office", "is_ignored": true}`.
Фильтр на фронтенде: «показывать только удалёнку» = `GET /vacancies?work_format=remote&is_ignored=false`.

| Код | Когда |
|---|---|
| 200 | Обновлённая `Vacancy` |
| 404 | `not_found` |
| 422 | Пустое тело, невалидные значения, `extra` поля |
| 503 | `db_unavailable` |

### 4.8. `DELETE /api/v1/vacancies/{vacancy_id}`

Мягкое скрытие: `is_ignored = TRUE` (RLS-политика `vacancies_worker_active` запрещает
`status = 'archived'`, а роль `navigator_worker` не имеет `DELETE`). Данные сохраняются —
скрытую вакансию можно вернуть тем же `PATCH`. Ответ — `200` с обновлённой `Vacancy`.

| Код | Когда |
|---|---|
| 200 | Скрыто, `is_ignored = true` |
| 404 | `not_found` |
| 503 | `db_unavailable` |

### 4.9. `GET /api/v1/rzhd/tickets`

| Query | Тип | Описание |
|---|---|---|
| `status` | `watching\|available\|booked\|expired\|cancelled` | Статус |
| `car_type` | `coupe\|platzkart\|sv\|sitting\|luxury` | Тип вагона |
| `direction_from` / `direction_to` | str | Направление (ILIKE, регистр не важен) |
| `travel_date_from` / `travel_date_to` | date | Окно дат отправления |
| `only_available` | bool | `seats_available > 0` |
| `limit` / `offset` | 1..200 / ≥ 0 | Пагинация |

Сортировка — `travel_date ASC, price_rub ASC NULLS LAST, id ASC` (что покупать в первую очередь).
Ответ — `{"items": [RzhdTicket], "total": N}`.

### 4.10. `POST /api/v1/rzhd/tickets`

UPSERT по `UNIQUE (direction_from, direction_to, travel_date, train_number, car_type)` —
повторный опрос вотчера не создаёт дубли.

```http
POST /api/v1/rzhd/tickets
{"direction_from": "Санкт-Петербург", "direction_to": "Москва",
 "travel_date": "2026-12-26", "train_number": "016А", "car_type": "coupe",
 "seats_available": 12, "price_rub": 4820, "booking_url": "https://ticket.rzd.ru/...",
 "status": "available", "trip_window_start": "2026-12-26", "trip_window_end": "2027-01-09"}
```

| Код | Когда |
|---|---|
| 201 | Рейс добавлен |
| 200 | Рейс уже наблюдался — обновлены места/цена/статус |
| 422 | Нет направления/даты/типа вагона, `trip_window_end < trip_window_start`, `extra` поля |
| 503 | `db_unavailable` |

### 4.11. `POST /api/v1/ai/classify-preview`

Сквозной бизнес-сценарий: текст → LLM (DeepSeek/OpenRouter) → строгий Structured Output →
сохранение в PostgreSQL → структурированный ответ фронтенду. Полный алгоритм — §5.

```http
POST /api/v1/ai/classify-preview
{"kind": "email", "sender": "promo@shop.ru", "sender_name": "Shop",
 "subject": "Промокод на 5000 ₽ до воскресенья",
 "text": "Только сегодня: промокод SALE5000 на всё. https://shop.ru/promo",
 "account_id": 1}
```

```json
{
  "kind": "email",
  "classification": {"category": "SPAM_VALUABLE", "priority": "HIGH",
                     "summary": "Промокод SALE5000 на 5000 ₽ действует до воскресенья.",
                     "spam_tag": "promo", "spam_url": "https://shop.ru/promo",
                     "work_format": null},
  "ai": {"provider": "deepseek", "model": "deepseek-chat", "used_model": "deepseek-chat",
         "fallback_model": "deepseek-reasoner", "fallback_used": false, "attempts": 1,
         "max_tokens": 400, "temperature": 0.1, "timeout_sec": 15.0,
         "latency_ms": 1840, "json_mode": true},
  "persisted": {"email_id": 13, "valuable_spam_id": 4, "vacancy_id": null}
}
```

| Код | Когда |
|---|---|
| 200 | Классификация получена и (при `persist=true`) сохранена |
| 422 | `text` пуст/длиннее 20000, `kind="vacancy"` без `vacancy_title`, `extra` поля |
| 502 | `llm_unavailable` — обе модели не ответили за `3` попытки каждая |
| 503 | `db_unavailable` — не удалось прочитать `ai_instructions` или сохранить результат |

### 4.12. `GET /api/v1/emails`

Лента обработанных писем из таблицы `emails`. Имя папки приходит из
`LEFT JOIN mail_folders` (`folder_id` может быть `NULL`), сортировка — `created_at DESC, id DESC`.

| Query | Тип | Описание |
|---|---|---|
| `limit` | 1..200, по умолчанию 20 | Размер ленты |
| `category` | `WHITELIST\|CRITICAL\|VACANCY\|SPAM_VALUABLE\|SPAM` | Категория ИИ |
| `folder_id` | int ≥ 1 | Только письма указанной папки |
| `status` | `new\|classified\|notified\|ignored\|deleted\|error` | Статус обработки |

```json
{"items": [{"id": 55, "account_id": 1, "folder_id": 12, "folder_name": "INBOX",
            "message_id": "<vacancy-42@alfersoft.ru>", "external_id": "vacancy-42@alfersoft.ru",
            "sender": "hr@alfersoft.ru", "sender_name": "AlferSoft HR",
            "subject": "Стажировка C++ разработчик, зимний набор",
            "received_at": "2026-11-23T09:40:00+00:00", "category": "VACANCY",
            "priority": "HIGH", "ai_summary": "Стажировка C++20, дедлайн отклика 05.12.2026.",
            "spam_tag": null, "spam_url": null, "status": "classified",
            "is_seen": false, "is_deleted": false, "ai_model": "deepseek-chat",
            "error_text": null, "processed_at": "2026-11-23T09:41:00+00:00",
            "created_at": "2026-11-23T09:42:00+00:00"}],
 "total": 1, "limit": 20}
```

Ошибки: `422` — `category`/`status` вне перечня, `limit` вне 1..200; `503 db_unavailable`.

### 4.13. `POST /api/v1/mail/sync-folders`

Инициирует одноразовый IMAP `LIST` → UPSERT `mail_folders`, переиспользуя штатный режим воркера
(`agents/mail_worker.py --sync-folders`, таймаут 180 с). После завершения API перечитывает снимок
папок и возвращает `FolderSyncResult` (§3.3) — `folders_total` уже по данным PostgreSQL.

```json
{"status": "ok", "exit_code": 0, "folders_saved": 19, "failures": 0,
 "folders_total": 19, "duration_ms": 2158,
 "detail": "SYNC-FOLDERS: ящиков=1, папок сохранено=19, ошибок=0"}
```

| Код | Когда |
|---|---|
| 200 | Процесс завершён (успех или `status = "error"` с причиной в `detail`) |
| 503 | `db_unavailable` — пул не создан, снимок папок прочитать нечем |

### 4.14. Сводная таблица

| Метод | Путь | Успех | Ошибки |
|---|---|---|---|
| GET | `/api/v1/health` | 200 | — |
| GET | `/api/v1/dashboard/summary` | 200 | 503 |
| GET | `/api/v1/mail/folders` | 200 | 503 |
| PATCH | `/api/v1/mail/folders/{id}` | 200 | 404, 422, 503 |
| GET | `/api/v1/emails` | 200 | 422, 503 |
| POST | `/api/v1/mail/sync-folders` | 200 | 503 |
| GET | `/api/v1/vacancies` | 200 | 422, 503 |
| POST | `/api/v1/vacancies` | 201/200 | 422, 503 |
| PATCH | `/api/v1/vacancies/{id}` | 200 | 404, 422, 503 |
| DELETE | `/api/v1/vacancies/{id}` | 200 | 404, 503 |
| GET | `/api/v1/rzhd/tickets` | 200 | 422, 503 |
| POST | `/api/v1/rzhd/tickets` | 201/200 | 422, 503 |
| POST | `/api/v1/ai/classify-preview` | 200 | 422, 502, 503 |

## 5. AI-фича: `POST /api/v1/ai/classify-preview`

### 5.1. Провайдер и модели

| Что | Источник | Значение по умолчанию |
|---|---|---|
| Провайдер | `LLM_PROVIDER` | `deepseek` (альтернатива — `openrouter`) |
| Base URL | `LLM_BASE_URL` | `https://api.deepseek.com` / `https://openrouter.ai/api/v1` |
| Ключ | `ENV_DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` | нет — AI-фича вернёт `502` |
| Модель | `ai_instructions` (`scope='global'`, `scope_key='classifier'`), затем `LLM_MODEL` | `deepseek-chat` |
| Резервная модель | там же (`fallback_model`), затем `LLM_FALLBACK_MODEL` | `deepseek-reasoner` |
| Бюджет ответа | `ai_instructions.max_tokens` (кап `1024`, дефолт `400`) | `400` |
| Температура | `ai_instructions.temperature` | `0.1` |
| Промпт | `ai_instructions.prompt` + жёсткий JSON-контракт | контракт из §5.2 |

Настройки живут в БД, а не в коде: владелец может снизить `max_tokens` или переключить модель
одним `UPDATE ai_instructions` — API подхватит их на следующем запросе (кеша нет).

### 5.2. Structured Output (строгая Pydantic-схема)

Модель обязана вернуть **только JSON-объект** (режим `response_format={"type":"json_object"}`);
ответ валидируется `AiClassification.model_validate`, а не «доверием к JSON»:

```json
{
  "category": "SPAM_VALUABLE",
  "summary": "Промокод SALE5000 на 5000 ₽ действует до воскресенья.",
  "spam_tag": "promo",
  "spam_url": "https://shop.ru/promo",
  "work_format": null
}
```

Правила нормализации (совпадают с `agents/mail_worker.EmailClassification`):

* `category` приводится к канону (`spam-valuable` → `SPAM_VALUABLE`), иначе `ValidationError` → retry;
* `summary` — пробелы нормализуются, обрезка до 600 символов;
* `spam_tag` — обрезка до 64 символов, пустая строка → `null`;
* `spam_url` — только `http/https` с хостом, иначе `null` (защита от `javascript:`/`data:`);
* `work_format` — только `remote|hybrid|office`, иначе `null`;
* `priority` **не** приходит от модели: он вычисляется детерминированно
  (`WHITELIST|CRITICAL|VACANCY|SPAM_VALUABLE → HIGH`, `SPAM → LOW`).

### 5.3. Контроль стоимости, таймаут, retry и fallback

| Механизм | Значение | Где настраивается |
|---|---|---|
| Жёсткий таймаут одного запроса | `15.0 с` (`asyncio.wait_for`) | `AI_TIMEOUT_SEC` |
| Повторы на основной модели | `3` | `AI_RETRY_ATTEMPTS` |
| Экспоненциальный backoff | `1.5 → 3 → 6 с` (потолок 8 с) | `AI_RETRY_BASE_DELAY_SEC` |
| Резервная модель | после исчерпания 3 попыток основной | `ai_instructions.fallback_model` |
| Бюджет ответа | `max_tokens` из `ai_instructions`, кап 1024 | `ai_instructions` |
| Длина входа | текст ≤ 20000 символов, в промпт уходит ≤ 6000 | константа `AI_MAX_INPUT_CHARS` |

Алгоритм (`classify_with_cascade` в `api/main.py`):

1. Прочитать `ai_instructions` (модель, fallback, `max_tokens`, `temperature`, промпт) — ошибка БД → `503`.
2. Для `model` в `[основная, резервная]`, для `attempt` в `1..3`:
   * запрос к LLM под `asyncio.wait_for(..., timeout=15.0)`;
   * JSON разобран и провалидирован → успех, выходим;
   * таймаут / ошибка провайдера / битый JSON / нарушение схемы → запись в `attempts`,
     `sleep(base * 2^(attempt-1))`, повтор;
3. Основная модель исчерпала попытки → переключение на резервную (`fallback_used = true`);
4. Обе модели упали → `LlmUnavailable` → `502 llm_unavailable` (в ответе нет текста ошибки
   провайдера — только `code`/`message` без ключей и промптов).

Таймаут «зависшего» провайдера не блокирует воркер uvicorn: каждый запрос ограничен
`wait_for`, а весь запрос LLM не превышает `2 модели × 3 попытки × 15 с` + backoff.

### 5.4. Сохранение результата

| `kind` | Категория | Запись в БД |
|---|---|---|
| `email` | любая | `emails` — UPSERT по `(account_id, external_id)`: `category`, `priority`, `summary`, `spam_tag`, `spam_url`, `status='classified'`, `ai_model`, `processed_at` |
| `email` | `SPAM_VALUABLE` | дополнительно `valuable_spam` — UPSERT по `email_id` (`spam_tag`, `spam_url`, `summary`, `sender`, `subject`, `received_at`); письмо помечается `status='deleted'`, `is_deleted=TRUE` (как в воркере) |
| `vacancy` | любая | `vacancies` — INSERT с `source='ai-preview'`, `status='new'`, `score` = уверенность (100 для `VACANCY`), `raw.api.work_format` из ответа модели |

`account_id` не передан → берётся первый активный ящик (`SELECT id FROM mail_accounts ORDER BY id LIMIT 1`,
RLS сам отфильтрует выключенные). Аккаунтов нет → `409`-подобной ситуации не возникает:
используется `503 db_unavailable` с `message` «нет активных почтовых ящиков», потому что
`emails.account_id` объявлен `NOT NULL` и запись невозможна.

`persist=false` — «сухой» прогон: LLM вызывается, БД только читается (`ai_instructions`),
`persisted` = `{}`. Удобно для отладки промптов из Swagger без мусора в журналах.
## 6. TDD-петля: тесты до реализации

Файл `tests/test_api_tdd.py` (pytest + `httpx.AsyncClient` + `ASGITransport`) написан **до**
`api/main.py`. БД и LLM подменяются фейками (`FakeGateway`, `FakeLlm`), которые кладутся в
`app.state` — те же зависимости, что использует lifespan (`get_gateway`, `get_llm`), поэтому
прогон детерминирован, не требует сети и не тратит токены.

| # | Тест | Что фиксирует контракт |
|---|---|---|
| 1 | `test_health_ok` | `/health` = 200, `database.status="ok"` |
| 2 | `test_health_degraded_without_db` | пул не создан → 200 + `status="degraded"` |
| 3 | `test_cors_preflight_allows_frontend` | `OPTIONS` с `Origin: http://localhost:3000` → `access-control-allow-origin` |
| 4 | `test_dashboard_summary` | форма сводки: mail/valuable_spam/vacancies/rzhd/ai |
| 5 | `test_dashboard_summary_db_unavailable` | `503` + `detail.code="db_unavailable"` |
| 6 | `test_list_mail_folders` | список папок, вычисленный `scan_mode` |
| 7 | `test_patch_mail_folder` | PATCH меняет `scan_mode`/`is_selectable` |
| 8 | `test_patch_mail_folder_not_found` | `404 not_found` |
| 9 | `test_patch_mail_folder_validation` | `scan_mode="everything"` → `422` |
| 10 | `test_list_vacancies_filters` | фильтры `work_format`/`is_ignored` доходят до шлюза |
| 11 | `test_list_vacancies_invalid_work_format` | `422` |
| 12 | `test_create_vacancy` | `201`, тело с `work_format="remote"` |
| 13 | `test_create_vacancy_validation` | нет `title` → `422`; `salary_max < salary_min` → `422` |
| 14 | `test_patch_vacancy_ignore_office` | `is_ignored=true` + `work_format="office"` |
| 15 | `test_patch_vacancy_not_found` | `404` |
| 16 | `test_delete_vacancy_soft_hide` | `200`, `is_ignored=true`, физического DELETE нет |
| 17 | `test_list_rzhd_tickets` | `only_available` фильтр, сортировка из шлюза |
| 18 | `test_create_rzhd_ticket` | `201` |
| 19 | `test_create_rzhd_ticket_validation` | `car_type="wagon"` → `422`, окно дат → `422` |
| 20 | `test_ai_classify_preview_email` | Structured Output, сохранение в `emails` |
| 21 | `test_ai_classify_preview_spam_valuable` | запись в `valuable_spam`, письмо → `deleted` |
| 22 | `test_ai_classify_preview_retry_on_invalid_json` | 1-й ответ битый → 2-й валиден, `attempts=2` |
| 23 | `test_ai_classify_preview_fallback_model` | таймаут основной → резервная модель, `fallback_used=true` |
| 24 | `test_ai_classify_preview_all_models_fail` | `502 llm_unavailable` |
| 25 | `test_ai_classify_preview_db_unavailable` | `503 db_unavailable` |
| 26 | `test_ai_classify_preview_budget_from_db` | `max_tokens` из `ai_instructions` уходит в LLM |
| 27 | `test_ai_classify_preview_persist_false` | `persisted` пуст, запись не выполняется |
| 28 | `test_ai_classify_preview_hard_timeout` | `asyncio.wait_for` режет зависший ответ, включается резервная модель |
| 29 | `test_ai_classify_preview_vacancy` | `kind="vacancy"` → запись в `vacancies` с `work_format` |
| 30 | `test_ai_classify_preview_validation` | пустой `text`, вакансия без названия, `extra` поле → `422` |
| 31 | `test_openapi_contains_all_endpoints` | `/openapi.json` содержит все 8 путей (11 операций) |

Факт прогона: `31 passed`, exit code `0` (см. `pytest.ini`, запуск `python -m pytest`).

Запуск:

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_api_tdd.py -v
```

Критерий приёмки этапа: `exit code 0`, 100% passed.

## 7. Подключение фронтенда

```ts
// web/lib/api/client.ts (пример; базовый URL — из переменной окружения Next.js)
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

export async function getDashboardSummary(signal?: AbortSignal) {
  const response = await fetch(`${API_BASE}/api/v1/dashboard/summary`, { signal });
  if (!response.ok) throw new Error(`summary: HTTP ${response.status}`);
  return response.json();
}
```

* Типы генерируются из `http://127.0.0.1:8000/openapi.json` (`openapi-typescript`), ручное
  дублирование схем запрещено — единственный источник истины находится в `api/main.py`.
* Баннер `PartialBanner`/`OfflineBanner` включается по `database.status` из `/health`.
* Записи (`PATCH`/`POST`/`DELETE`) выполняются из клиентских компонентов с optimistic update
  (`web/components/interactive/OptimisticAction.tsx`), при `4xx/5xx` — откат состояния.

## 8. Ограничения и следующий шаг

1. **Нет аутентификации** — MVP для локального стенда; перед публикацией нужен минимум
   API-ключ в заголовке или mTLS на reverse-proxy.
2. **Мягкое удаление вакансий** вместо физического — следствие RLS/least privilege (§2.3, §4.8).
3. **Квоты LLM** не считаются в деньгах: контролируются только `max_tokens`, таймаут и число попыток.
4. **`ai_instructions` не кешируется** — сознательный выбор: правки лимитов применяются сразу.
5. **Миграция `003_api_columns.sql`** (опционально, владелец БД) — переносит `is_ignored`,
   `work_format`, `scan_mode` в нативные колонки с индексами:

   ```sql
   ALTER TABLE vacancies ADD COLUMN IF NOT EXISTS is_ignored BOOLEAN NOT NULL DEFAULT FALSE;
   ALTER TABLE vacancies ADD COLUMN IF NOT EXISTS work_format TEXT
       CHECK (work_format IS NULL OR work_format IN ('remote', 'hybrid', 'office'));
   ALTER TABLE mail_folders ADD COLUMN IF NOT EXISTS scan_mode TEXT NOT NULL DEFAULT 'full'
       CHECK (scan_mode IN ('full', 'headers', 'skip'));
   CREATE INDEX IF NOT EXISTS idx_vacancies_ignored ON vacancies (is_ignored);
   CREATE INDEX IF NOT EXISTS idx_vacancies_work_format ON vacancies (work_format);
   ```

   До её применения API использует `raw.api` / `flags` (§2.4) — контракт не меняется.







