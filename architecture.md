# Architecture — Backend / DB слой AI Dev Navigator

> Версия: 1.0 · Дата: 23.11.2026 · Статус: реализовано (миграция `001_init_schema`)
> Связанные артефакты: `db/migrations/001_init_schema.sql`,
> `agents/mail_worker.py`, `config/orchestrator.json`, `docs/handoff/PRD_CHALLENGE.md`.

## 1. Контекст и цели

До этого этапа состояние проекта хранилось в SQLite-кэше (`storage.sqlite`,
`data/cache.db`) и в памяти воркера. Для сдачи ДЗ по Backend/DB добавлен
полноценный слой PostgreSQL:

| Цель | Решение |
|---|---|
| Хранение аккаунтов, папок и писем | 7 нормализованных таблиц PostgreSQL 14+ |
| Изоляция «живых» данных воркера | роль `navigator_worker` + Row-Level Security |
| Секреты вне БД | в таблицах только имена `ENV_*`-переменных, значения — в `.env` |
| Dedup писем | `UNIQUE (account_id, external_id)` |
| Настраиваемые лимиты ИИ | таблица `ai_instructions` (`model`, `fallback_model`, `max_tokens`) |
| Устойчивость LLM | 15 с таймаут, 3 retry с экспоненциальным backoff, fallback-модель |
| Полезный спам | `valuable_spam` + пометка письма `\Deleted` в IMAP |

Драйвер — `asyncpg` (пул соединений `asyncpg.create_pool`), доступ к БД
инкапсулирован в `AsyncpgGateway`; воркер не знает про SQL напрямую.

## 2. ER-диаграмма

```mermaid
erDiagram
    mail_accounts {
        bigint id PK
        text email UK
        text imap_host
        int imap_port
        text mailbox
        text env_password_key
        boolean is_active
        timestamptz last_sync_at
    }
    mail_folders {
        bigint id PK
        bigint account_id FK
        text name
        text raw_name
        text delimiter
        text_array flags
        text special_use
        boolean is_selectable
        timestamptz last_synced_at
    }
    emails {
        bigint id PK
        bigint account_id FK
        bigint folder_id FK
        text external_id
        text sender
        text subject
        timestamptz received_at
        text category
        text priority
        text summary
        text status
        boolean is_deleted
    }
    valuable_spam {
        bigint id PK
        bigint email_id FK
        bigint account_id FK
        text spam_tag
        text spam_url
        text summary
        timestamptz expires_at
    }
    rzhd_tickets {
        bigint id PK
        text direction_from
        text direction_to
        date travel_date
        text car_type
        int seats_available
        numeric price_rub
        text status
    }
    vacancies {
        bigint id PK
        text source
        text external_id
        text title
        text_array stack
        numeric salary_min
        numeric salary_max
        text status
    }
    ai_instructions {
        bigint id PK
        text scope
        text scope_key
        text model
        text fallback_model
        int max_tokens
        boolean is_active
    }

    mail_accounts ||--o{ mail_folders : "has folders"
    mail_accounts ||--o{ emails : "receives"
    mail_folders  ||--o{ emails : "groups"
    emails        ||--|| valuable_spam : "promoted to"
    mail_accounts ||--o{ valuable_spam : "owns"
    ai_instructions }o..o{ mail_accounts : "scoped by key"
    ai_instructions }o..o{ vacancies : "scores"
    ai_instructions }o..o{ rzhd_tickets : "advises"
```

Сплошные линии — реальные внешние ключи (`REFERENCES`), пунктирные —
логическая связь через `scope`/`scope_key` (промпт применяется к ящику,
категории, отправителю или каналу).

## 3. Таблицы и связи

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `mail_accounts` | ящики, которые опрашивает воркер | `UNIQUE(email)`, `email = lower(email)`, `env_password_key ~ '^ENV_[A-Z0-9_]+$'` |
| `mail_folders` | снимок IMAP-папок (`--sync-folders`) | `UNIQUE(account_id, name)`, `ON DELETE CASCADE` |
| `emails` | журнал писем и вердиктов ИИ | `UNIQUE(account_id, external_id)`, `CHECK` по `category`/`priority`/`status` |
| `valuable_spam` | выжимка полезного спама | `UNIQUE(email_id)`, `CHECK (spam_tag OR spam_url OR summary)` |
| `rzhd_tickets` | рейсы/места РЖД | `UNIQUE(direction, date, train, car_type)`, `seats_available >= 0` |
| `vacancies` | вакансии сканера | `UNIQUE(source, external_id)`, `GIN(stack)`, `GIN(tags)` |
| `ai_instructions` | промпты и лимиты ИИ | `UNIQUE(scope, scope_key)`, `max_tokens BETWEEN 64 AND 4096` |

Связи:

* `mail_accounts 1 — N mail_folders` (`CASCADE`): удаление ящика убирает папки.
* `mail_accounts 1 — N emails` (`CASCADE`): журнал живёт вместе с ящиком.
* `mail_folders 1 — N emails` (`SET NULL`): папку можно пересоздать при
  синхронизации, письма при этом не теряются.
* `emails 1 — 1 valuable_spam` (`CASCADE`): одна запись на письмо.
* `mail_accounts 1 — N valuable_spam`: быстрый фильтр по ящику.

Соглашения: суррогатные `BIGINT GENERATED ALWAYS AS IDENTITY` (без расширений),
все моменты времени — `TIMESTAMPTZ`, денормализованные массивы (`stack`, `flags`)
только там, где фильтрация идёт по GIN, JSONB (`raw`) — для ответов внешних API.
Имена таблиц — `snake_case`, множественное число; SQL-ключи и статусы — `UPPER_SNAKE`.

## 4. Индексы и обоснование

Индексы добавлены только под запросы, которые реально выполняют воркеры и
дашборд; «на всякий случай» ничего не создаётся.

| Индекс | Запрос / сценарий | Почему нужен |
|---|---|---|
| `UNIQUE mail_accounts_email_key` | поиск ящика по адресу, сид | гарантирует уникальность и даёт btree для `WHERE email = $1` |
| `idx_mail_accounts_active` (partial) | выборка активных ящиков | RLS-предикат `is_active`; частичный индекс компактнее полного |
| `UNIQUE mail_folders_account_name_key` | UPSERT папок при `--sync-folders` | `ON CONFLICT` требует уникальный индекс, повторный sync не плодит дубли |
| `idx_mail_folders_account` | «какие папки у ящика» | покрывает `ORDER BY name` и фильтр по ящику |
| `UNIQUE emails_account_external_key` | дедупликация писем | основа `ON CONFLICT` в `upsert_email` |
| `idx_emails_account_received` | лента писем в дашборде | `ORDER BY received_at DESC LIMIT n` без сортировки в памяти |
| `idx_emails_category_received` (partial) | фильтр «CRITICAL/SPAM_VALUABLE за период» | узкий индекс без NULL-строк |
| `idx_emails_status_pending` (partial) | очередь `new`/`error` | маленький индекс на «горячие» строки |
| `idx_emails_sender_lower` | поиск по отправителю | функциональный индекс для регистронезависимого поиска |
| `UNIQUE valuable_spam_email_key` | защита от дублей | одно письмо — одна выжимка |
| `idx_valuable_spam_account_created` | лента полезного спама | `ORDER BY created_at DESC` по ящику |
| `idx_valuable_spam_tag` (partial) | группировка по тегам (`promo`, `sale`) | индексируются только строки с тегом |
| `idx_valuable_spam_summary_fts` (GIN) | полнотекстовый поиск по выжимке | `to_tsvector('simple', …)` immutable → допустим в индексе |
| `UNIQUE rzhd_tickets_offer_key` | UPSERT рейсов из `rzhd_watcher` | идемпотентность cron-запусков |
| `idx_rzhd_tickets_available` (partial) | «где есть места» | `seats_available > 0` — самый частый фильтр канала |
| `idx_rzhd_tickets_price` (partial) | минимальная цена по дате | покрывает `min(price_rub)` по дате |
| `idx_rzhd_tickets_status` (partial) | активные наблюдения | узкий набор статусов |
| `UNIQUE vacancies_source_external_key` | дедупликация вакансий | UPSERT из сканера |
| `idx_vacancies_stack`, `idx_vacancies_tags` (GIN) | `stack @> ARRAY['C++']` | массивные фильтры без seq scan |
| `idx_vacancies_published` | сортировка по свежести | `DESC NULLS LAST` соответствует контракту UI |
| `idx_vacancies_salary` (partial) | сортировка по вилке | частичный по непустой зарплате |
| `UNIQUE ai_instructions_scope_key` | выборка промпта по scope | гарантирует единственность инструкции на область |
| `idx_ai_instructions_active` (partial) | чтение активных инструкций | RLS-предикат `is_active` |

Проверка плана (после наполнения данными):

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, sender, subject, category
FROM emails
WHERE account_id = 1
ORDER BY received_at DESC
LIMIT 20;
-- ожидается Index Scan по idx_emails_account_received
```

## 5. Ролевая модель `navigator_worker`

Принцип: **least privilege**. Владелец БД (`postgres` или админ проекта)
применяет миграции и вручную включает логин роли; воркер работает только под
`navigator_worker`.

| Объект | Права `navigator_worker` | Обоснование |
|---|---|---|
| `CONNECT` на базу | да | воркеру нужен доступ к БД |
| `USAGE` на `public` | да | поиск объектов схемы |
| `mail_accounts` | `SELECT`; `UPDATE (last_sync_at, last_error, updated_at)` | читать ящики, писать только служебный статус |
| `mail_folders` | `SELECT, INSERT, UPDATE, DELETE` | `--sync-folders` пересобирает снимок папок |
| `emails` | `SELECT, INSERT, UPDATE` | журнал писем и вердиктов |
| `valuable_spam` | `SELECT, INSERT, UPDATE` | запись выжимки полезного спама |
| `vacancies`, `rzhd_tickets` | `SELECT, INSERT, UPDATE` | каналы воркеров |
| `ai_instructions` | только `SELECT` | менять промпты может только владелец |
| `schema_migrations` | нет прав | служебная таблица миграций |

> Модель прав выше — **целевое** состояние из
> `db/migrations/001_init_schema.sql` §9. На живом стенде роль изначально
> получила более широкие табличные гранты; расхождение закрыто миграцией
> `db/migrations/002_tighten_worker_grants.sql`, применённой владельцем БД, —
> факты «до/после» и пробы в §13.4.2 / §13.3.

Секреты:

1. В `.env` (или в переменных окружения Windows) хранятся
   `DATABASE_URL`, `ENV_MAIL_PRIMARY_USERNAME`, `ENV_MAIL_PRIMARY_PASSWORD`,
   `ENV_DEEPSEEK_API_KEY`.
2. В `mail_accounts` лежит только имя переменной пароля
   (`env_password_key = 'ENV_MAIL_PRIMARY_PASSWORD'`), сам пароль воркер читает
   через `os.environ.get()`.
3. DSN в логах маскируется (`mask_dsn`: пароль → `***`), пароль и API-ключ не
   попадают ни в `stdout`, ни в `stderr`.
4. Пароль роли БД не хранится в репозитории: после миграции выполняется
   `ALTER ROLE navigator_worker WITH LOGIN PASSWORD '<secret>'`.

`BYPASSRLS` роли **не выдаётся**: иначе воркер увидел бы выключенные ящики.
Если подключиться суперпользователем, RLS обходится (владелец таблицы
по умолчанию не подчиняется политикам) — на этот случай `AsyncpgGateway`
проверяет `is_active` у каждой полученной строки и пропускает неактивные
с предупреждением в `stderr`.

## 6. Политики Row-Level Security

RLS включён на всех 7 таблицах. Политики адресованы только роли
`navigator_worker`; владелец БД (миграции, админский дашборд) продолжает
видеть всё.

| Таблица | Политика | Предикат | Смысл |
|---|---|---|---|
| `mail_accounts` | `mail_accounts_worker_select_active` (`SELECT`) | `is_active` | воркер получает **только активные** ящики, `WHERE is_active` в коде не нужен |
| `mail_accounts` | `mail_accounts_worker_update_active` (`UPDATE`) | `is_active` в `USING` и `WITH CHECK` | нельзя включить выключенный ящик и нельзя «оживить» чужой |
| `mail_folders` | `..._worker_active_account` (`ALL`) | `account_id IN (SELECT id FROM mail_accounts)` | папки только активных ящиков |
| `emails` | `..._worker_active_account` (`ALL`) | то же | журнал только активных ящиков |
| `valuable_spam` | `..._worker_active_account` (`ALL`) | то же | выжимки только активных ящиков |
| `vacancies` | `vacancies_worker_active` (`ALL`) | `status <> 'archived'` | архив скрыт от воркера |
| `rzhd_tickets` | `rzhd_tickets_worker_window` (`ALL`) | `trip_window_end >= CURRENT_DATE - 30 days` | окно хранения каникул |
| `ai_instructions` | `ai_instructions_worker_select_active` (`SELECT`) | `is_active` | воркер не читает выключенные промпты |

Ключевой приём: подзапрос `SELECT id FROM mail_accounts` внутри политики
выполняется **под той же ролью**, поэтому к нему тоже применяется RLS.
Получается каскад: выключили ящик (`is_active = FALSE`) — воркер мгновенно
перестаёт видеть и сам ящик, и его папки, письма и полезный спам, без единой
правки в Python-коде.

Проверка (под ролью воркера):

```sql
SET ROLE navigator_worker;
SELECT email FROM mail_accounts;      -- только is_active = TRUE
UPDATE mail_accounts SET is_active = FALSE WHERE email = 'oshkines@mail.ru';
-- ERROR: new row violates row-level security policy (WITH CHECK не пускает)
RESET ROLE;
```

> Фактический прогон этих проверок на стенде и его результаты (включая живой
> IMAP-снимок папок) — §13 «Результаты проверки RLS и доступа».

Ограничение: `FORCE ROW LEVEL SECURITY` намеренно не включён, иначе владелец
схемы не смог бы наполнять справочники. Для продакшена с несколькими
арендаторами включается `ALTER TABLE ... FORCE ROW LEVEL SECURITY` и отдельная
админская роль с `BYPASSRLS`.

## 7. LLM Structured Output и устойчивость

### 7.1 Строгая схема ответа (Pydantic v2)

Контракт классификатора — ровно четыре поля; всё остальное модель вернуть не
имеет права (лишние ключи отбрасываются, неверная категория — ошибка):

```python
class EmailClassification(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    category: Literal["WHITELIST", "CRITICAL", "VACANCY", "SPAM_VALUABLE", "SPAM"]
    summary: str = ""                 # 1–2 предложения по-русски
    spam_tag: str | None = None       # короткий тег: promo, sale, coupon
    spam_url: str | None = None       # http(s)-ссылка из письма
```

Приоритет воркера выводится из категории детерминированно:
`WHITELIST | CRITICAL | VACANCY | SPAM_VALUABLE → HIGH`, `SPAM → LOW`.
Так «дорогая» ветка (полное тело + суммаризация) никогда не включается
из-за капризов модели.

Валидация выполняется через `model_validate`, а не «доверием к JSON»:

* `category` нормализуется (`spam-valuable` → `SPAM_VALUABLE`), неизвестное
  значение → `ValidationError` → `AiAnalysisError` → повтор запроса;
* `summary` обрезается до 600 символов, `spam_tag` — до 64;
* `spam_url` принимается только со схемой `http/https`, иначе `None`
  (защита от `javascript:`/`data:` в ссылке, которую потом увидит UI).

### 7.2 Контроль стоимости и отказоустойчивость

| Механизм | Значение по умолчанию | Где настраивается |
|---|---|---|
| Жёсткий таймаут одного запроса | `15 с` (`asyncio.wait_for`) | `workers.mail_worker.ai.timeout_sec` |
| Повторы при сбое API | `3` попытки | `ai.retry_attempts` |
| Экспоненциальная задержка | `1.5 → 3 → 6 с` (потолок 8 с) | `ai.retry_base_delay_sec` |
| Резервная модель | `deepseek-reasoner` | `ai.fallback_model` |
| Бюджет ответа | `max_tokens = 400` (кап 1024) | `ai.max_tokens` **или** `ai_instructions.max_tokens` |
| Превью для классификации | 200 символов | `ai.classify_chars` |
| Суммаризация | только `CRITICAL`, до 700 токенов | `ai.summary_max_tokens` |

Алгоритм `request_chat`:

1. попытка 1 → 2 → 3 на основной модели; между попытками `sleep(base * 2^n)`;
2. если все три упали (таймаут, 5xx, 429, отказ JSON-режима) — переключение
   на `fallback_model` и снова до трёх попыток;
3. если и резерв не ответил — `AiAnalysisError`, письмо остаётся
   непрочитанным и повторяется в следующем цикле (не теряется).

Отдельно обрабатывается провайдер без `response_format=json_object`:
запрос повторяется без этого параметра (совместимость с локальной Ollama).
Каждый шаг ограничен таймаутом, поэтому «зависший» API не блокирует ящик.

### 7.3 Ветка `SPAM_VALUABLE`

1. Классификатор вернул `category = "SPAM_VALUABLE"` + `summary`, `spam_tag`,
   `spam_url`.
2. `emails` — UPSERT письма со статусом `deleted` и `is_deleted = TRUE`.
3. `valuable_spam` — INSERT/UPDATE выжимки (`UNIQUE (email_id)` защищает от
   повторов при перечитывании письма).
4. Только после успешной записи в БД воркер отправляет
   `STORE <seq> +FLAGS (\Deleted)` — письмо помечается на удаление из ящика.
5. В ядро уходит уведомление `action = "spam_valuable"` с полями
   `summary`, `spam_tag`, `spam_url`.

Если БД недоступна, письмо **не удаляется** (нельзя терять данные без
сохранённой выжимки), но уведомление в ядро всё равно уходит, а событие
помечается `db_unavailable`. Это осознанный компромисс: лучше оставить письмо
в ящике, чем безвозвратно удалить его без записи в `valuable_spam`.

## 8. Синхронизация папок (`--sync-folders`)

Режим нужен, чтобы в `mail_folders` появился реальный список папок ящика,
включая пользовательские папки Mail.ru («Отправленные», «Черновики», фильтры).

Порядок:

1. Воркер получает активные ящики из `mail_accounts` (RLS отдаёт только
   `is_active = TRUE`), пароль берёт из `os.environ[env_password_key]`.
2. Подключение по IMAP (`aioimaplib`, `IMAP4_SSL`, жёсткие таймауты на
   greeting/login/select/list).
3. Команда `LIST "" "*"`; каждая строка вида
   `(\HasNoChildren) "/" "INBOX"` разбирается регуляркой в `FolderInfo`
   (`flags`, `delimiter`, `name`, `raw_name`).
4. Имена приходят в **modified UTF-7** (RFC 3501): кириллица Mail.ru выглядит
   как `&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-`. Воркер декодирует её в UTF-8
   (`decode_imap_utf7`) и сохраняет читаемое имя в `name`, а исходную строку —
   в `raw_name` для отладки.
5. `INSERT ... ON CONFLICT (account_id, name) DO UPDATE` обновляет флаги,
   разделитель и `last_synced_at`. Повторный запуск идемпотентен.
6. В `stdout` уходит событие `{"action": "folders_synced", "folders": N}`.

Запуск:

```powershell
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --sync-folders
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --sync-folders --account oshkines@mail.ru
```

Без `DATABASE_URL` режим завершится ошибкой конфигурации: сохранять папки
некуда. Ошибка IMAP по одному ящику не мешает остальным — ящики
обрабатываются независимо.

## 9. Поток обработки письма

```mermaid
sequenceDiagram
    participant W as mail_worker
    participant DB as PostgreSQL
    participant IMAP as IMAP (Mail.ru)
    participant LLM as DeepSeek
    participant Core as C++ core

    W->>DB: SELECT * FROM mail_accounts  (RLS: is_active)
    DB-->>W: oshkines@mail.ru + env_password_key
    W->>IMAP: LOGIN + SELECT INBOX
    W->>IMAP: SEARCH UNSEEN
    W->>IMAP: FETCH HEADER + 200 chars
    alt sender in white_list
        W->>Core: WHITELIST (0 токенов)
    else
        W->>LLM: classify (15s, 3 retry, fallback)
        LLM-->>W: {category, summary, spam_tag, spam_url}
        alt SPAM_VALUABLE
            W->>DB: UPSERT emails + INSERT valuable_spam
            W->>IMAP: STORE +FLAGS (\Deleted)
            W->>Core: spam_valuable (summary/tag/url)
        else CRITICAL
            W->>IMAP: FETCH full body
            W->>LLM: summarize
            W->>Core: critical + summary
        else VACANCY / SPAM
            W->>DB: UPSERT emails
            W->>Core: classified (только HIGH)
        end
    end
    W->>IMAP: STORE +FLAGS (\Seen)
```

## 10. Эксплуатация

### 10.1 Применение миграции

```powershell
# 1. Переменные окружения (или .env - воркер читает его при старте)
$env:DATABASE_URL = "postgresql://postgres:<admin-password>@127.0.0.1:5432/ai_dev_orchestrator"

# 2. Схема + роль + RLS + сид основного ящика
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/migrations/001_init_schema.sql

# 3. Логин служебной роли (пароль в репозиторий не попадает)
psql $env:DATABASE_URL -c "ALTER ROLE navigator_worker WITH LOGIN PASSWORD '<worker-password>';"

# 4. Проверка: подключение под воркером
$env:DATABASE_URL = "postgresql://navigator_worker:<worker-password>@127.0.0.1:5432/ai_dev_orchestrator"
psql $env:DATABASE_URL -c "SELECT email, is_active FROM mail_accounts;"

# 5. Ужесточение прав роли до модели least privilege (см. §13.4.1).
#    Выполняется ВЛАДЕЛЬЦЕМ БД: роль воркера не может отзывать чужие гранты.
psql "postgresql://postgres:<admin-password>@<host>:5432/ai_dev_navigator" `
  -v ON_ERROR_STOP=1 -f db/migrations/002_tighten_worker_grants.sql
```

### 10.2 Переменные `.env`

| Переменная | Назначение | Где используется |
|---|---|---|
| `DATABASE_URL` | DSN PostgreSQL (asyncpg) | `storage.postgres.dsn_env` |
| `ENV_MAIL_PRIMARY_USERNAME` | логин ящика | `mail_accounts.username_env_key` |
| `ENV_MAIL_PRIMARY_PASSWORD` | пароль приложения | `mail_accounts.env_password_key` |
| `ENV_DEEPSEEK_API_KEY` | ключ DeepSeek | `ai.api_key` |

`.env` читается при старте (`load_dotenv(override=False)`), существующие
переменные Windows имеют приоритет. Шаблон без значений — `.env.example`.

### 10.3 Команды воркера

```powershell
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --dry-run        # без сети, DSN маскирован
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --sync-folders   # IMAP LIST -> mail_folders
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --once           # один цикл опроса
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py                  # сервис
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --no-db --provider primary  # legacy-режим
```

### 10.4 Диагностические запросы

```sql
-- состояние ящиков (под владельцем)
SELECT email, is_active, last_sync_at, last_error FROM mail_accounts;

-- последние вердикты ИИ
SELECT received_at, sender, category, priority, status
FROM emails ORDER BY received_at DESC LIMIT 20;

-- полезный спам за неделю
SELECT created_at, spam_tag, spam_url, summary
FROM valuable_spam WHERE created_at > now() - INTERVAL '7 days'
ORDER BY created_at DESC;

-- снимок папок после --sync-folders
SELECT m.email, f.name, f.special_use, f.last_synced_at
FROM mail_folders f JOIN mail_accounts m ON m.id = f.account_id
ORDER BY m.email, f.name;
```

## 11. Соответствие требованиям ДЗ

| Требование | Реализация | Проверка |
|---|---|---|
| 7 таблиц PostgreSQL | `db/migrations/001_init_schema.sql` §1–7 | `psql -c "\dt"` → 8 таблиц (+ `schema_migrations`) |
| ER-диаграмма и связи | `architecture.md` §2–3 | Mermaid-блок в этом файле |
| Обоснование индексов | §4 | таблица «индекс → запрос → зачем» |
| Ролевая модель `navigator_worker` | §5, SQL §9 | `\du navigator_worker`, `information_schema.role_table_grants` |
| Политики RLS | §6, SQL §10 | `SELECT * FROM pg_policies` → 8 политик |
| Живой прогон RLS, прав и папок Mail.ru | §13 | 19 строк в `mail_folders`, 8 политик, `42501` на `DELETE`/`UPDATE email`/`INSERT schema_migrations`; расхождение грантов закрыто миграцией `002` — §13.4.2 |
| Ящики из `mail_accounts` под RLS | `AsyncpgGateway.fetch_active_accounts` | `--dry-run` показывает источник `database` |
| Пароль из `.env` по `env_password_key` | `MailAccount.password` | в логах только `env_password_key`, не значение |
| `--sync-folders` + кастомные папки Mail.ru | `MailboxWorker.folder_sync`, `decode_imap_utf7` | событие `folders_synced`, строки в `mail_folders` |
| Pydantic-схема ответа | `EmailClassification` | тест `test_classification_parsing` |
| `max_tokens` из конфига/БД | `AISettings.max_tokens` + `ai_instructions` | `fetch_ai_overrides` |
| Таймаут 15 с | `ai.timeout_sec` + `asyncio.wait_for` | тест `test_retry_and_fallback` |
| 3 retry с экспоненциальной задержкой | `request_chat` | счётчик вызовов фейкового клиента |
| Fallback на резервную модель | `ai.fallback_model` | модель в тесте переключается |
| `SPAM_VALUABLE` → `valuable_spam` + `\Deleted` | `_handle_non_critical`/`_save_valuable_spam` | тест `test_valuable_spam_flow` |

## 12. Допущения и ограничения

1. **Один владелец.** `vacancies` и `rzhd_tickets` не содержат `owner_id`:
   проект однопользовательский (PRD §1). При появлении второго пользователя
   добавляется `owner_id` и политика `owner_id = current_setting('app.owner_id')`.
2. **`\Deleted` без `EXPUNGE`.** Воркер помечает письмо на удаление, но не
   вызывает `EXPUNGE`: команда удаляет все помеченные письма в папке, включая
   чужие. Очистка выполняется почтовым клиентом или отдельной админской
   задачей (`UID EXPUNGE` по списку seq).
3. **DeepSeek Structured Output.** Провайдер поддерживает `json_object`, но не
   `json_schema`, поэтому схема навязывается промптом и проверяется Pydantic.
   Для OpenAI-совместимых провайдеров с `json_schema` переключатель уже
   заложен (`json_mode` + `request_chat`).
4. **`asyncpg` — обязательная зависимость** для режима БД. Без пакета воркер
   работает в legacy-режиме (`--no-db`), но `--sync-folders` и `valuable_spam`
   требуют БД.
5. **`.env` и безопасность.** `python-dotenv` загружается с `override=False`:
   переменные, заданные в Windows, не перетираются файлом. Значения не
   логируются; в конфиге только имена переменных (`ENV_*`).
6. **RLS vs владелец таблицы.** Владелец схемы обходит RLS; для реального
   ограничения воркер обязан подключаться ролью `navigator_worker`.
7. **Партиционирование.** При объёме писем > 10 млн строк `emails` логично
   разбить по месяцам (`PARTITION BY RANGE (received_at)`); в текущем объёме
   достаточно btree-индексов.
8. **UI-контракт.** `storage.sqlite` сохранён в конфиге для обратной
   совместимости с дашбордом Phase 5; первичным хранилищем объявлен
   `storage.postgres` (`"primary": "postgres"`), SQLite остаётся legacy-кэшем
   дедупликации.

## 13. Результаты проверки RLS и доступа

> Финальный прогон после миграции `002`: 23.11.2026, 20:25–20:27 MSK. Сервер
> `82.148.236.43:5432`, база `ai_dev_navigator`, роль `navigator_worker`,
> **PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)**, клиент — Windows 11 +
> `.venv` (Python 3.12.14, `asyncpg` 0.32.0, `aioimaplib`, `pydantic` 2.14.1).
> Все ответы ниже — фактический вывод команд, ничего не додумано.
>
> Корректирующая миграция `db/migrations/002_tighten_worker_grants.sql`
> применена на стенде **владельцем БД `postgres`** (история — §13.4.1), поэтому
> все пробы прав в §13.3 сняты заново, уже после применения: `UPDATE email`,
> `UPDATE is_active`, `INSERT INTO mail_accounts` и любое обращение к
> `schema_migrations` теперь дают `ERROR [42501] permission denied`.
> Предыдущий прогон (20:06–20:08, до миграции) зафиксировал расхождение
> грантов — сравнение «было → стало» в §13.4.2.
>
> Самый первый прогон (19:56–20:00) был заблокирован: в `.env` строки были
> закомментированы, сервер отвечал `InvalidPasswordError [28P01]`.

### 13.1. Сводная таблица проверок

| # | Что проверялось | Инструмент | Фактический результат | Итог |
|---|---|---|---|---|
| 1 | TCP до PostgreSQL | `socket.connect(("82.148.236.43", 5432))` | `OK` | ✓ |
| 2 | TCP до IMAP | `socket.connect(("imap.mail.ru", 993))` | `OK` | ✓ |
| 3 | Загрузка `.env` | `python-dotenv` + `os.environ` | `DATABASE_URL loaded=True` | ✓ |
| 4 | Подключение под ролью | `asyncpg.connect(DATABASE_URL)` | `current_user='navigator_worker'`, `current_database='ai_dev_navigator'`, `inet_server_addr='82.148.236.43/32'` | ✓ |
| 5 | Таблицы в `public` | `information_schema.tables` | 8: `ai_instructions`, `emails`, `mail_accounts`, `mail_folders`, `rzhd_tickets`, `schema_migrations`, `vacancies`, `valuable_spam` | ✓ |
| 6 | RLS включён | `pg_class.relrowsecurity` | 7 таблиц `rls=True`, `schema_migrations` — `False`; `force_rls=False` везде | ✓ |
| 7 | Политики RLS | `pg_policies` | 8 политик, все адресованы `{navigator_worker}` | ✓ |
| 8 | Атрибуты роли | `pg_roles` | `rolsuper=False`, `rolcanlogin=True`, `rolbypassrls=False`, `rolcreatedb=False`, `rolcreaterole=False` | ✓ |
| 9 | `--dry-run` | `python agents\mail_worker.py --dry-run` | exit `0` (23.11.2026 20:30:06, после миграции `002`); `источник ящиков=database`, `PostgreSQL=настроен`, `DSN=postgresql://navigator_worker:***@82.148.236.43:5432/ai_dev_navigator`, `api_key="set"` | ✓ |
| 10 | `--sync-folders` | `python agents\mail_worker.py --sync-folders` | exit `0` (23.11.2026 20:26:57); `LIST: папок получено=19`, `mail_folders: сохранено папок=19`, `folders_synced folders=19 saved=19`, `SYNC-FOLDERS: ящиков=1, папок сохранено=19, ошибок=0` | ✓ |
| 11 | Негативные тесты прав | протокол §13.3 (после миграции `002`) | `DELETE`, `UPDATE email`, `UPDATE is_active`, `INSERT mail_accounts`, `INSERT/UPDATE/SELECT schema_migrations`, `SET ROLE postgres` — все `42501`; `UPDATE last_error` / `UPDATE last_sync_at` — `UPDATE 1` | ✓ все запреты на месте |
| 12 | `mail_folders` в БД | `SELECT id, name, raw_name, message_count` | 19 строк (см. §13.5), `message_count = 0` во всех | ✓ |
| 13 | MCP-сервер `postgres` | `cline_mcp_settings.json` | в рабочем файле только `context7`, глобальный — `{"mcpServers": {}}`; SQL-пробы выполнены напрямую через `asyncpg` | ⚠ MCP не подключён |
| 14 | Column-level гранты `mail_accounts` | `information_schema.column_privileges` | `SELECT` — 16 колонок; `UPDATE` — только `last_error`, `last_sync_at`, `updated_at` | ✓ |
| 15 | Права на `schema_migrations` | `has_table_privilege` × 4 | `SELECT/INSERT/UPDATE/DELETE → False`; `pg_class.relacl = {postgres=arwdDxt/postgres}` | ✓ |
| 16 | `DELETE` на журналах | пробы §13.3 | `emails`, `valuable_spam`, `vacancies`, `rzhd_tickets` → `42501` | ✓ |
| 17 | `ai_instructions` только чтение | пробы §13.3 | `SELECT scope, prompt` → `SELECT 2`; `INSERT`/`UPDATE` → `42501` | ✓ |

### 13.2. Инвентаризация, снятая под `navigator_worker`

```text
current_user=navigator_worker | current_database=ai_dev_navigator
inet_server_addr=82.148.236.43/32 | PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

RLS по таблицам (relrowsecurity / relforcerowsecurity):
  ai_instructions   True / False      mail_folders   True / False
  emails            True / False      rzhd_tickets   True / False
  mail_accounts     True / False      vacancies      True / False
  schema_migrations False / False     valuable_spam  True / False

Политики (pg_policies, 8 шт., все TO navigator_worker):
  ai_instructions  ai_instructions_worker_select_active        SELECT  qual=is_active
  emails           emails_worker_active_account                ALL     qual=(account_id IN (SELECT id FROM mail_accounts))
  mail_accounts    mail_accounts_worker_select_active          SELECT  qual=is_active
  mail_accounts    mail_accounts_worker_update_active          UPDATE  qual=is_active  check=is_active
  mail_folders     mail_folders_worker_active_account          ALL     qual=(account_id IN (SELECT id FROM mail_accounts))
  rzhd_tickets     rzhd_tickets_worker_window                  ALL     qual=(trip_window_end IS NULL OR trip_window_end >= CURRENT_DATE - 30 days)
  vacancies        vacancies_worker_active                     ALL     qual=(status <> 'archived')
  valuable_spam    valuable_spam_worker_active_account         ALL     qual=(account_id IN (SELECT id FROM mail_accounts))
```

Соответствие `pg_policies` миграции `001_init_schema` — **полное**: предикаты,
команды и адресация роли совпадают один в один.

### 13.3. Негативные тесты прав и RLS: фактические ответы БД (после миграции `002`)

Каждый зонд выполнялся в **собственной** транзакции `asyncpg` с гарантированным
откатом (в выводе после каждого — «транзакция откатана»), поэтому данные не
изменились. При отказе `42501` PostgreSQL прерывает транзакцию, а контекстный
менеджер `asyncpg` откатывает её — ни одна строка не фиксируется.
Формат ответа: `RESULT: <команда> <строки>` — успех, `ERROR [SQLSTATE] ...` — отказ.

| # | SQL (роль `navigator_worker`) | Фактический ответ PostgreSQL | Вывод |
|---|---|---|---|
| 1 | `SELECT current_user, current_database();` | `navigator_worker \| ai_dev_navigator` | подключение именно служебной ролью |
| 2 | `SELECT id, email, is_active FROM mail_accounts;` | 1 строка: `id=1 \| email='oshkines@mail.ru' \| is_active=True` | политика `..._select_active` работает |
| 3 | `SELECT count(*) FROM mail_accounts WHERE is_active = FALSE;` | `inactive_visible=0` | выключенные ящики скрыты RLS, а не фильтром в коде |
| 4 | `DELETE FROM mail_accounts;` | `ERROR [42501] permission denied for table mail_accounts` | `DELETE` в ACL отсутствует |
| 5 | `UPDATE mail_accounts SET email = email;` | `ERROR [42501] permission denied for table mail_accounts` | ✅ **было `UPDATE 1`** — колоночный грант закрыл запись адреса |
| 6 | `UPDATE mail_accounts SET imap_host = imap_host;` | `ERROR [42501] permission denied for table mail_accounts` | IMAP-хост менять нельзя |
| 7 | `UPDATE mail_accounts SET env_password_key = env_password_key;` | `ERROR [42501] permission denied for table mail_accounts` | ключ пароля менять нельзя |
| 8 | `UPDATE mail_accounts SET is_active = FALSE;` | `ERROR [42501] permission denied for table mail_accounts` | теперь отказ на уровне ACL; до `WITH CHECK` политики дело не доходит |
| 9 | `INSERT INTO mail_accounts (label, email, imap_host, env_password_key) VALUES (...);` | `ERROR [42501] permission denied for table mail_accounts` | в модели прав `INSERT` не предусмотрен |
| 10 | `UPDATE mail_accounts SET last_error = 'probe' WHERE id = 1;` | `RESULT: UPDATE 1` (откатано) | служебный статус писать разрешено |
| 11 | `UPDATE mail_accounts SET last_sync_at = last_sync_at WHERE id = 1;` | `RESULT: UPDATE 1` (откатано) | `touch_account` воркера продолжает работать |
| 12 | `SET ROLE postgres;` | `ERROR [42501] permission denied to set role "postgres"` | членства в админ-роли нет, эскалация закрыта |
| 13 | `SELECT version, description FROM schema_migrations;` | `ERROR [42501] permission denied for table schema_migrations` | прав нет даже на чтение журнала миграций |
| 14 | `INSERT INTO schema_migrations (version, description) VALUES ('rls_probe','probe');` | `ERROR [42501] permission denied for table schema_migrations` | ✅ **было `INSERT 0 1`** — подделка журнала миграций закрыта |
| 15 | `UPDATE schema_migrations SET description = description;` | `ERROR [42501] permission denied for table schema_migrations` | журнал неизменяем для воркера |
| 16 | `DELETE FROM emails;` | `ERROR [42501] permission denied for table emails` | журнал писем не удаляется (только `INSERT/SELECT/UPDATE`) |
| 17 | `DELETE FROM valuable_spam;` | `ERROR [42501] permission denied for table valuable_spam` | выжимка полезного спама защищена от удаления |
| 18 | `DELETE FROM vacancies;` | `ERROR [42501] permission denied for table vacancies` | канал вакансий защищён |
| 19 | `DELETE FROM rzhd_tickets;` | `ERROR [42501] permission denied for table rzhd_tickets` | канал билетов защищён |
| 20 | `INSERT INTO ai_instructions (scope, scope_key, prompt) VALUES ('global','probe','probe');` | `ERROR [42501] permission denied for table ai_instructions` | промпты/лимиты меняет только владелец |
| 21 | `UPDATE ai_instructions SET prompt = prompt;` | `ERROR [42501] permission denied for table ai_instructions` | то же |
| 22 | `SELECT scope, prompt FROM ai_instructions;` | `RESULT: SELECT 2` (откатано) | чтение промптов сохранено (воркер грузит лимиты ИИ) |
| 23 | `INSERT INTO mail_folders (account_id, name, raw_name) VALUES (1,'probe','probe');` | `RESULT: INSERT 0 1` (откатано) | `--sync-folders` должен писать снимок папок |
| 24 | `DELETE FROM mail_folders WHERE id = -1;` | `RESULT: DELETE 0` (откатано) | `DELETE` на `mail_folders` сохранён намеренно (cleanup снимка) |
| 25 | `INSERT INTO emails (account_id, external_id, received_at) VALUES (1,'probe',now());` | `RESULT: INSERT 0 1` (откатано) | журнал писем пополняется |
| 26 | `DELETE FROM emails WHERE id = -1;` | `ERROR [42501] permission denied for table emails` | но не чистится воркером |
| 27 | `SELECT * FROM pg_policies WHERE schemaname = 'public';` | 8 строк (см. §13.2) | инвентаризация политик совпадает с миграцией |

Каскад RLS (дочерние таблицы под воркером после синхронизации 20:26 MSK):
`SELECT (SELECT count(*) FROM mail_folders) AS folders, (SELECT count(*) FROM emails) AS emails,
(SELECT count(*) FROM valuable_spam) AS valuable_spam, (SELECT count(*) FROM mail_accounts) AS accounts,
(SELECT count(*) FROM mail_accounts WHERE is_active = FALSE) AS inactive;`
→ `folders=19 | emails=0 | valuable_spam=0 | accounts=1 | inactive_visible=0`.

Состояние ящика после `--sync-folders`:
`id=1 | email='oshkines@mail.ru' | is_active=True | last_sync_at=2026-11-23 17:26:57.096125Z | last_error=None`
(`last_sync_at`/`updated_at` заполнены воркером через `touch_account` — колоночный
`UPDATE` работает; `last_error` пуст — ошибок не было).

Важно: после миграции `002` воркер **не может прочитать `schema_migrations`**
(`42501`), поэтому строку `002_tighten_worker_grants` в журнале он не видит.
Факт применения подтверждается не журналом, а фактическими ACL и
`information_schema` (§13.4.2) — этим и снята инвентаризация выше.

### 13.4. Расхождение «миграция ↔ живой сервер»: было и чем закрыто

> Ниже — состояние **до** миграции `002` (прогон 20:06–20:08). Оставлено как
> история для ДЗ: на текущем стенде расхождения больше нет — фактические гранты
> после применения в §13.4.2, пробы — §13.3.

Политики RLS на сервере совпадали с миграцией, а **гранты были шире**, чем
объявляет `001_init_schema.sql` §9. Факты (до миграции `002`):

```text
pg_class.relacl для mail_accounts:
  {postgres=arwdDxt/postgres, navigator_worker=arw/postgres}
  a=INSERT r=SELECT w=UPDATE (d=DELETE отсутствует) -> запрет DELETE подтверждён

information_schema.role_table_grants (grantee = navigator_worker):
  ai_instructions    INSERT, SELECT, UPDATE        (в миграции: только SELECT)
  emails             DELETE, INSERT, SELECT, UPDATE (в миграции: без DELETE)
  mail_accounts      INSERT, SELECT, UPDATE        (в миграции: INSERT нет; UPDATE - только 3 колонки)
  mail_folders       DELETE, INSERT, SELECT, UPDATE (совпадает)
  rzhd_tickets       DELETE, INSERT, SELECT, UPDATE (в миграции: без DELETE)
  schema_migrations  INSERT, SELECT, UPDATE        (в миграции: прав нет)
  vacancies          DELETE, INSERT, SELECT, UPDATE (в миграции: без DELETE)
  valuable_spam      DELETE, INSERT, SELECT, UPDATE (в миграции: без DELETE)

information_schema.column_privileges (mail_accounts): 48 строк =
  16 колонок x {INSERT, SELECT, UPDATE}  -> грант табличный, column-level отсутствует
```

Причина: на сервере был выполнен широкий `GRANT INSERT, SELECT, UPDATE`
(и `DELETE` на часть таблиц) на уровне таблиц, а не гранулярный
`GRANT SELECT` + `GRANT UPDATE (last_sync_at, last_error, updated_at)` из
миграции. Членства в других ролях и `ALTER DEFAULT PRIVILEGES` нет
(`pg_auth_members` и `pg_default_acl` пусты), владелец таблиц — `postgres`.

Последствия: `navigator_worker` мог переписать адрес ящика, его IMAP-хост,
`env_password_key` и `is_active` (последнее ловил только RLS `WITH CHECK`),
а также вставлять строки в `schema_migrations`. Закрыто идемпотентной
миграцией от владельца БД — **`db/migrations/002_tighten_worker_grants.sql`**
(что именно она делает и почему её не может применить роль воркера — §13.4.1).

Тело фикса (идемпотентно): `REVOKE ALL ON ALL TABLES/SEQUENCES` → повторные
`GRANT` ровно по модели §5 → запись строки `002_tighten_worker_grants` в
`schema_migrations`:

```sql
-- db/migrations/002_tighten_worker_grants.sql (фрагмент)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM navigator_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM navigator_worker;

GRANT SELECT ON mail_accounts TO navigator_worker;
GRANT UPDATE (last_sync_at, last_error, updated_at)
    ON mail_accounts TO navigator_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON mail_folders TO navigator_worker;
GRANT SELECT, INSERT, UPDATE
    ON emails, valuable_spam, vacancies, rzhd_tickets TO navigator_worker;
GRANT SELECT ON ai_instructions TO navigator_worker;
-- schema_migrations: прав не выдаём

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO navigator_worker;
```

Проверки из шапки миграции прогнаны после применения — их **фактические**
ответы (не ожидания) в §13.3 и §13.4.2.

**Важно:** грант на `DELETE` для `mail_folders` сохранён намеренно —
`--sync-folders` пересобирает снимок папок, и эта таблица по модели прав
воркеру доступна полностью.

#### 13.4.1. Почему миграцию `002` может применить только владелец БД

Скрипт идемпотентен: `REVOKE ALL ON ALL TABLES/SEQUENCES` → повторные `GRANT`
по модели §5 → отметка `002_tighten_worker_grants` в `schema_migrations`.

Применить её от лица `navigator_worker` **невозможно**: роль не владелец
таблиц (`owner = postgres`) и не имеет `WITH GRANT OPTION`, поэтому PostgreSQL
не отзывает и не выдаёт чужие гранты, а лишь предупреждает. Проверено
экспериментально (транзакция + `ROLLBACK`, ACL не изменился):

```text
current_user: navigator_worker
owner of mail_accounts: postgres

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM navigator_worker;  -> status REVOKE
GRANT SELECT ON mail_accounts TO navigator_worker;               -> status GRANT
ACL до:       {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}
ACL внутри:   {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}   <- не изменился
ACL после:    {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}

Сообщения сервера:
  WARNING: no privileges could be revoked for column "priority" of relation "ai_instructions"
  WARNING: no privileges could be revoked for column "created_at" of relation "ai_instructions"
  WARNING: no privileges could be revoked for column "updated_at" of relation "ai_instructions"
  WARNING: no privileges were granted for "mail_accounts"
```

Вывод: `REVOKE`/`GRANT` от не-владельца — **silent no-op** (код возврата `0`,
ошибки нет, эффекта нет). Применять миграцию должен владелец БД:

```powershell
psql "postgresql://postgres:<admin-password>@82.148.236.43:5432/ai_dev_navigator" `
  -v ON_ERROR_STOP=1 -f db/migrations/002_tighten_worker_grants.sql
```

Миграция применена владельцем БД на стенде 23.11.2026 (перед прогоном 20:25–20:27).
Проверки из шапки `002_tighten_worker_grants.sql` прогнаны после применения;
фактические ответы — §13.3.

#### 13.4.2. Фактические гранты после применения `002` (снято под `navigator_worker`)

```text
information_schema.role_table_grants (grantee = navigator_worker):
  ai_instructions    SELECT
  emails             INSERT, SELECT, UPDATE
  mail_accounts      SELECT
  mail_folders       DELETE, INSERT, SELECT, UPDATE
  rzhd_tickets       INSERT, SELECT, UPDATE
  vacancies          INSERT, SELECT, UPDATE
  valuable_spam      INSERT, SELECT, UPDATE
  schema_migrations  <нет строк — прав нет>

information_schema.column_privileges (mail_accounts):
  SELECT (16) -> created_at, email, env_password_key, id, imap_host, imap_port,
                 is_active, label, last_error, last_sync_at, mailbox,
                 max_messages_per_poll, poll_interval_sec, updated_at, use_ssl,
                 username_env_key
  UPDATE  (3) -> last_error, last_sync_at, updated_at

has_table_privilege(current_user, ...):
  mail_accounts     SELECT=True  INSERT=False UPDATE=False DELETE=False
  schema_migrations SELECT=False INSERT=False UPDATE=False DELETE=False

pg_class.relacl:
  ai_instructions    {postgres=arwdDxt/postgres,navigator_worker=r/postgres}
  emails             {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}
  mail_accounts      {postgres=arwdDxt/postgres,navigator_worker=r/postgres}
  mail_folders       {postgres=arwdDxt/postgres,navigator_worker=arwd/postgres}
  rzhd_tickets       {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}
  schema_migrations  {postgres=arwdDxt/postgres}
  vacancies          {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}
  valuable_spam      {postgres=arwdDxt/postgres,navigator_worker=arw/postgres}

sequence USAGE grants: navigator_worker=7  (USAGE, SELECT — INSERT ... DEFAULT работает)
```

Сверка «было → стало» по проблемным точкам:

| Проверка | До `002` | После `002` |
|---|---|---|
| `UPDATE mail_accounts SET email = email;` | `UPDATE 1` | `ERROR [42501]` |
| `UPDATE mail_accounts SET imap_host = imap_host;` | `UPDATE 1` | `ERROR [42501]` |
| `UPDATE mail_accounts SET env_password_key = env_password_key;` | `UPDATE 1` | `ERROR [42501]` |
| `UPDATE mail_accounts SET is_active = FALSE;` | `42501`, но от RLS `WITH CHECK` | `42501` уже от ACL |
| `INSERT INTO mail_accounts ...` | `INSERT 0 1` | `ERROR [42501]` |
| `INSERT INTO schema_migrations ...` | `INSERT 0 1` | `ERROR [42501]` |
| `SELECT ... FROM schema_migrations` | `SELECT` | `ERROR [42501]` |
| `DELETE FROM emails / valuable_spam / vacancies / rzhd_tickets` | `DELETE n` | `ERROR [42501]` |
| `INSERT/UPDATE ai_instructions` | разрешено | `ERROR [42501]` |
| `UPDATE mail_accounts SET last_sync_at = ...` | `UPDATE 1` | `UPDATE 1` (сохранено) |
| `INSERT/DELETE mail_folders` | разрешено | разрешено (сохранено) |

`UPDATE is_active = FALSE` теперь не доходит до `WITH CHECK` политики
`mail_accounts_worker_update_active`: колонка `is_active` не входит в
колоночный грант `UPDATE`, поэтому ACL отказывает раньше. Политика остаётся
вторым рубежом (например, для будущего расширения грантов).


### 13.5. Снимок `mail_folders` после живой синхронизации

Команда: `.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --sync-folders`
(ящик `oshkines@mail.ru`, `imap.mail.ru:993`, 23.11.2026 20:26:56–20:26:57 MSK,
**после** применения миграции `002` — least privilege не сломал запись папок).
Вывод воркера (exit `0`):

```text
[2026-11-23 20:26:56] БД: подключено к postgresql://navigator_worker:***@82.148.236.43:5432/ai_dev_navigator (пул 1-5, timeout 15с)
[2026-11-23 20:26:56] БД: лимиты ИИ из ai_instructions: ['fallback_model', 'max_tokens', 'model']
[2026-11-23 20:26:56] БД: активных ящиков=1 (RLS is_active), к работе=1
[2026-11-23 20:26:57] [oshkines@mail.ru] LIST: папок получено=19
[2026-11-23 20:26:57] [oshkines@mail.ru] mail_folders: сохранено папок=19
{"worker": "mail_worker", ..., "action": "folders_synced", "folders": 19, "saved": 19, "timestamp": "2026-11-23T20:26:57+03:00"}
[2026-11-23 20:26:57] SYNC-FOLDERS: ящиков=1, папок сохранено=19, ошибок=0
```

Фактическая выборка из БД
`SELECT id, name, raw_name, message_count FROM mail_folders ORDER BY id;`:

| id | name | raw_name | message_count |
|---|---|---|---|
| 1 | `INBOX` | `INBOX` | 0 |
| 2 | `z_Arhiv` | `z_Arhiv` | 0 |
| 3 | `murmansk@pochta.ru` | `murmansk@pochta.ru` | 0 |
| 4 | `Курсы 1С` | `&BBoEQwRABEEESw- 1&BCE-` | 0 |
| 5 | `Курсы` | `&BBoEQwRABEEESw-` | 0 |
| 6 | `Спам` | `&BCEEPwQwBDw-` | 0 |
| 7 | `Отправленные` | `&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-` | 0 |
| 8 | `Черновики` | `&BCcENQRABD0EPgQyBDgEOgQ4-` | 0 |
| 9 | `Корзина` | `&BBoEPgRABDcEOAQ9BDA-` | 0 |
| 10 | `Archive` | `Archive` | 0 |
| 11 | `INBOX/Шабашка` | `INBOX/&BCgEMAQxBDAESAQ6BDA-` | 0 |
| 12 | `INBOX/Social` | `INBOX/Social` | 0 |
| 13 | `INBOX/Newsletters` | `INBOX/Newsletters` | 0 |
| 14 | `INBOX/News` | `INBOX/News` | 0 |
| 15 | `INBOX/Public services` | `INBOX/Public services` | 0 |
| 16 | `INBOX/Receipts` | `INBOX/Receipts` | 0 |
| 17 | `murmansk@pochta.ru/Junk` | `murmansk@pochta.ru/Junk` | 0 |
| 18 | `murmansk@pochta.ru/z_arh` | `murmansk@pochta.ru/z_arh` | 0 |
| 19 | `Курсы 1С/git hub EDT` | `&BBoEQwRABEEESw- 1&BCE-/git hub EDT` | 0 |

Итого 19 строк, `account_id = 1`, кириллица декодирована из modified UTF-7
(контроль: `decode_imap_utf7("&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-")` → `Отправленные`).
Метки времени после прогона: `max(mail_folders.last_synced_at) =
2026-11-23 17:26:56.885700+00:00`, `mail_accounts.last_sync_at =
2026-11-23 17:26:57.096125+00:00` (`touch_account` прошёл под колоночным `UPDATE`).

Про `message_count`: колонка везде `0` — это ожидаемо для текущей реализации.
`SQL_UPSERT_FOLDER` пишет только `account_id, name, raw_name, delimiter, flags,
special_use, is_selectable, last_synced_at`, а `LIST` не возвращает число писем
(для этого нужен отдельный `STATUS`/`SELECT` по каждой папке). Значение живёт
на дефолте `DEFAULT 0`. Физически в `INBOX` на момент прогона было
`2173 EXISTS` (получено командой `SELECT INBOX`).

### 13.6. Замечание к выборке `mail_folders`

Запрос из первичной постановки
`SELECT id, folder_name, imap_path, action_mode FROM mail_folders;`
на этой схеме невозможен: колонок `folder_name`, `imap_path`, `action_mode`
нет (`db/migrations/001_init_schema.sql`, §2). PostgreSQL вернул бы
`ERROR 42703: column "folder_name" does not exist`.

Реальные колонки снимка: `id`, `account_id`, `name`, `raw_name`, `delimiter`,
`flags`, `special_use`, `is_selectable`, `unread_count`, `message_count`,
`last_synced_at`. Корректный эквивалент:

```sql
SELECT id, name, raw_name, message_count
FROM mail_folders
ORDER BY id;
```

### 13.7. Состояние чек-листа

| Пункт | Состояние |
|---|---|
| `.env` заполнен (`DATABASE_URL`, `ENV_MAIL_PRIMARY_*`, `ENV_DEEPSEEK_API_KEY`) | ✓ `dotenv: DATABASE_URL loaded=True` |
| Подключение под `navigator_worker` | ✓ `current_user=navigator_worker` |
| `--dry-run` показывает источник `database` | ✓ |
| RLS скрывает неактивные ящики | ✓ (`inactive_visible=0`) |
| `DELETE FROM mail_accounts` запрещён | ✓ `42501` |
| `UPDATE ... SET is_active = FALSE` запрещён | ✓ `42501` (ACL: колонка не в гранте) |
| `UPDATE ... SET email = email` запрещён | ✓ `42501` (после миграции `002`; до неё было `UPDATE 1`) |
| `INSERT INTO schema_migrations` запрещён | ✓ `42501` (после миграции `002`; до неё было `INSERT 0 1`) |
| `SET ROLE postgres` запрещён | ✓ `42501` |
| `--sync-folders` записал папки | ✓ 19 строк, exit `0` (прогон 20:26:57) |
| Column-level grants совпадают с миграцией | ✓ `SELECT` 16 колонок + `UPDATE` 3 колонки → §13.4.2 |
| Права на `schema_migrations` отсутствуют | ✓ все 4 привилегии `False` → §13.4.2 |
| `DELETE` на журналах отсутствует | ✓ `emails`, `valuable_spam`, `vacancies`, `rzhd_tickets` → `42501` |
| `ai_instructions` только чтение | ✓ `SELECT 2` работает, `INSERT/UPDATE` → `42501` |
| MCP-сервер `postgres` | ✗ не зарегистрирован в `cline_mcp_settings.json` |
| Роль не может применить `REVOKE/GRANT` | ✓ подтверждено: `WARNING: no privileges were granted`, ACL не меняется |

### 13.8. Воспроизведение

```powershell
# 1. Конфигурация (пароли маскируются, сеть не используется)
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --dry-run

# 2. Живая синхронизация папок: IMAP LIST -> mail_folders (UPSERT)
.\\.venv\\Scripts\\python.exe agents\\mail_worker.py --sync-folders

# 3. Снимок папок (под navigator_worker - RLS отдаёт только активный ящик)
#    SELECT id, name, raw_name, message_count FROM mail_folders ORDER BY id;

# 4. Негативные тесты прав выполняются в транзакции с ROLLBACK (см. §13.3):
#    DELETE FROM mail_accounts;                       -> 42501
#    UPDATE mail_accounts SET email = email;          -> 42501
#    UPDATE mail_accounts SET is_active = FALSE;      -> 42501
#    SET ROLE postgres;                               -> 42501
#    SELECT/INSERT/UPDATE schema_migrations           -> 42501
#    DELETE FROM emails / valuable_spam / vacancies / rzhd_tickets -> 42501
#    INSERT/UPDATE ai_instructions                    -> 42501
#    UPDATE mail_accounts SET last_error = last_error; -> UPDATE 1 (разрешено)
#    INSERT/DELETE mail_folders                       -> разрешено (--sync-folders)
```

Диагностику удобнее снимать через MCP-сервер `postgres`; готовый фрагмент
`cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub", "--dsn", "postgresql://navigator_worker:<password>@82.148.236.43:5432/ai_dev_navigator"]
    }
  }
}
```


