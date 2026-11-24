-- ============================================================================
--  AI Dev Orchestrator - initial PostgreSQL schema (migration 001)
--  Target: PostgreSQL 14+ (identity columns, no external extensions)
--
--  Состав:
--    1. 7 доменных таблиц: mail_accounts, mail_folders, emails, valuable_spam,
--       rzhd_tickets, vacancies, ai_instructions;
--    2. индексы под фактические запросы воркеров (architecture.md §5);
--    3. ролевая модель: служебная роль navigator_worker (least privilege);
--    4. Row-Level Security: воркер видит только активные ящики и их данные.
--
--  Применение (PowerShell, из корня проекта):
--      psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/migrations/001_init_schema.sql
--
--  Пароль роли в репозитории НЕ хранится: после миграции владелец БД выдаёт
--  логин вручную:  ALTER ROLE navigator_worker WITH LOGIN PASSWORD '<secret>';
--
--  Скрипт идемпотентен: повторный запуск не ломает существующую схему.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Журнал миграций
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT        PRIMARY KEY,
    description TEXT        NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 1. mail_accounts - почтовые ящики, которые обслуживает воркер.
--
-- Пароль в таблице не хранится: только имя переменной окружения
-- (env_password_key, формат ENV_*). is_active = TRUE - единственный признак,
-- по которому RLS пускает воркер к строке.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_accounts (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label                 TEXT        NOT NULL,
    email                 TEXT        NOT NULL,
    imap_host             TEXT        NOT NULL,
    imap_port             INTEGER     NOT NULL DEFAULT 993
                                      CHECK (imap_port BETWEEN 1 AND 65535),
    use_ssl               BOOLEAN     NOT NULL DEFAULT TRUE,
    mailbox               TEXT        NOT NULL DEFAULT 'INBOX',
    env_password_key      TEXT        NOT NULL
                                      CHECK (env_password_key ~ '^ENV_[A-Z0-9_]+$'),
    username_env_key      TEXT        CHECK (username_env_key IS NULL
                                             OR username_env_key ~ '^ENV_[A-Z0-9_]+$'),
    poll_interval_sec     INTEGER     NOT NULL DEFAULT 120
                                      CHECK (poll_interval_sec >= 5),
    max_messages_per_poll SMALLINT    NOT NULL DEFAULT 10
                                      CHECK (max_messages_per_poll BETWEEN 1 AND 100),
    is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
    last_sync_at          TIMESTAMPTZ,
    last_error            TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mail_accounts_email_key UNIQUE (email),
    CONSTRAINT mail_accounts_email_lower_chk CHECK (email = lower(email))
);

COMMENT ON TABLE mail_accounts IS
    'Почтовые ящики воркера. Пароль в БД отсутствует: только имя ENV-переменной.';
COMMENT ON COLUMN mail_accounts.env_password_key IS
    'Имя переменной окружения с паролем приложения (ENV_MAIL_PRIMARY_PASSWORD).';
COMMENT ON COLUMN mail_accounts.is_active IS
    'TRUE - ящик опрашивается; RLS-политика отдаёт воркеру только такие строки.';

CREATE INDEX IF NOT EXISTS idx_mail_accounts_active
    ON mail_accounts (id)
    WHERE is_active;

-- ----------------------------------------------------------------------------
-- 2. mail_folders - реальные папки ящика, полученные по IMAP LIST
--    (--sync-folders). name хранится в декодированном виде (modified UTF-7),
--    raw_name - как ответил сервер: нужно для отладки Mail.ru.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_folders (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id     BIGINT      NOT NULL
                               REFERENCES mail_accounts(id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    raw_name       TEXT        NOT NULL,
    delimiter      TEXT,
    flags          TEXT[]      NOT NULL DEFAULT '{}',
    special_use    TEXT,
    is_selectable  BOOLEAN     NOT NULL DEFAULT TRUE,
    unread_count   INTEGER     NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
    message_count  INTEGER     NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mail_folders_account_name_key UNIQUE (account_id, name)
);

COMMENT ON TABLE mail_folders IS
    'Снимок папок IMAP-ящика. Обновляется идемпотентно (UPSERT account_id + name).';

CREATE INDEX IF NOT EXISTS idx_mail_folders_account
    ON mail_folders (account_id, name);

-- ----------------------------------------------------------------------------
-- 3. emails - все письма, прошедшие через воркер (dedup по external_id).
--
-- external_id = Message-ID, а при его отсутствии - синтетический ключ
-- "sender:subject:received_at:seq" (см. EmailEnvelope.external_id).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emails (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   BIGINT      NOT NULL
                             REFERENCES mail_accounts(id) ON DELETE CASCADE,
    folder_id    BIGINT      REFERENCES mail_folders(id) ON DELETE SET NULL,
    message_id   TEXT,
    external_id  TEXT        NOT NULL,
    sender       TEXT        NOT NULL DEFAULT '',
    sender_name  TEXT        NOT NULL DEFAULT '',
    subject      TEXT        NOT NULL DEFAULT '',
    received_at  TIMESTAMPTZ NOT NULL,
    category     TEXT        CHECK (category IN
                             ('WHITELIST', 'CRITICAL', 'VACANCY', 'SPAM_VALUABLE', 'SPAM')),
    priority     TEXT        CHECK (priority IN ('HIGH', 'LOW')),
    summary      TEXT,
    spam_tag     TEXT,
    spam_url     TEXT,
    status       TEXT        NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'classified', 'notified',
                                               'ignored', 'deleted', 'error')),
    is_seen      BOOLEAN     NOT NULL DEFAULT FALSE,
    is_deleted   BOOLEAN     NOT NULL DEFAULT FALSE,
    ai_model     TEXT,
    error_text   TEXT,
    processed_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT emails_account_external_key UNIQUE (account_id, external_id)
);

COMMENT ON TABLE emails IS
    'Журнал писем. UNIQUE (account_id, external_id) - дедупликация повторов IMAP.';
COMMENT ON COLUMN emails.status IS
    'new -> classified -> notified | ignored | deleted | error.';

CREATE INDEX IF NOT EXISTS idx_emails_account_received
    ON emails (account_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_emails_category_received
    ON emails (category, received_at DESC)
    WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_emails_status_pending
    ON emails (status)
    WHERE status IN ('new', 'error');

CREATE INDEX IF NOT EXISTS idx_emails_sender_lower
    ON emails (lower(sender));

-- ----------------------------------------------------------------------------
-- 4. valuable_spam - выжимка «полезного спама»: акции, промокоды, скидки.
--    Одно письмо даёт не более одной записи (UNIQUE email_id). После успешной
--    записи воркер помечает письмо \Deleted в ящике (см. architecture.md §8).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS valuable_spam (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_id    BIGINT      NOT NULL
                            REFERENCES emails(id) ON DELETE CASCADE,
    account_id  BIGINT      NOT NULL
                            REFERENCES mail_accounts(id) ON DELETE CASCADE,
    spam_tag    TEXT,
    spam_url    TEXT,
    summary     TEXT        NOT NULL DEFAULT '',
    sender      TEXT        NOT NULL DEFAULT '',
    subject     TEXT        NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valuable_spam_email_key UNIQUE (email_id),
    CONSTRAINT valuable_spam_payload_chk CHECK (
        spam_tag IS NOT NULL OR spam_url IS NOT NULL OR summary <> ''
    )
);

COMMENT ON TABLE valuable_spam IS
    'Полезный спам: выжимка, тег и ссылка. Источник - LLM-категория SPAM_VALUABLE.';

CREATE INDEX IF NOT EXISTS idx_valuable_spam_account_created
    ON valuable_spam (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_valuable_spam_tag
    ON valuable_spam (spam_tag)
    WHERE spam_tag IS NOT NULL;

-- Полнотекстовый поиск по выжимкам (immutable regconfig -> индекс допустим).
CREATE INDEX IF NOT EXISTS idx_valuable_spam_summary_fts
    ON valuable_spam
    USING gin (to_tsvector('simple'::regconfig, coalesce(summary, '')));

-- ----------------------------------------------------------------------------
-- 5. rzhd_tickets - наблюдение за билетами РЖД (каникулы Алфёровского вуза).
--    UNIQUE по «параметрам предложения» делает UPSERT из rzhd_watcher
--    идемпотентным и не плодит дубли при каждом запуске по cron.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rzhd_tickets (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    direction_from    TEXT        NOT NULL,
    direction_to      TEXT        NOT NULL,
    travel_date       DATE        NOT NULL,
    train_number      TEXT        NOT NULL DEFAULT '',
    car_type          TEXT        NOT NULL
                                  CHECK (car_type IN ('coupe', 'platzkart', 'sv',
                                                      'sitting', 'luxury')),
    seats_available   INTEGER     NOT NULL DEFAULT 0 CHECK (seats_available >= 0),
    price_rub         NUMERIC(10, 2) CHECK (price_rub IS NULL OR price_rub >= 0),
    booking_url       TEXT,
    status            TEXT        NOT NULL DEFAULT 'watching'
                                  CHECK (status IN ('watching', 'available',
                                                    'booked', 'expired', 'cancelled')),
    passenger_name    TEXT,
    trip_window_start DATE,
    trip_window_end   DATE,
    notified_at       TIMESTAMPTZ,
    raw               JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rzhd_tickets_offer_key UNIQUE
        (direction_from, direction_to, travel_date, train_number, car_type),
    CONSTRAINT rzhd_tickets_window_chk CHECK (
        trip_window_start IS NULL OR trip_window_end IS NULL
        OR trip_window_end >= trip_window_start
    )
);

COMMENT ON TABLE rzhd_tickets IS
    'Рейсы и места РЖД; UPSERT по (направление, дата, поезд, тип вагона).';

CREATE INDEX IF NOT EXISTS idx_rzhd_tickets_available
    ON rzhd_tickets (travel_date, car_type)
    WHERE seats_available > 0;

CREATE INDEX IF NOT EXISTS idx_rzhd_tickets_price
    ON rzhd_tickets (travel_date, price_rub)
    WHERE price_rub IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rzhd_tickets_status
    ON rzhd_tickets (status)
    WHERE status IN ('watching', 'available');

-- ----------------------------------------------------------------------------
-- 6. vacancies - вакансии сканера (C++, 1C, Remote).
--    GIN по stack/tags обслуживает фильтры вида stack @> ARRAY['C++'].
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vacancies (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source       TEXT        NOT NULL,
    external_id  TEXT        NOT NULL,
    title        TEXT        NOT NULL,
    company      TEXT        NOT NULL DEFAULT '',
    stack        TEXT[]      NOT NULL DEFAULT '{}',
    tags         TEXT[]      NOT NULL DEFAULT '{}',
    salary_min   NUMERIC(10, 2),
    salary_max   NUMERIC(10, 2),
    currency     TEXT        NOT NULL DEFAULT 'RUB',
    url          TEXT,
    published_at TIMESTAMPTZ,
    status       TEXT        NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'viewed', 'applied',
                                               'rejected', 'archived')),
    score        SMALLINT    CHECK (score BETWEEN 0 AND 100),
    raw          JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vacancies_source_external_key UNIQUE (source, external_id),
    CONSTRAINT vacancies_salary_chk CHECK (
        salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min
    )
);

COMMENT ON TABLE vacancies IS
    'Вакансии сканера. UNIQUE (source, external_id) - дедупликация между запусками.';

CREATE INDEX IF NOT EXISTS idx_vacancies_stack
    ON vacancies USING gin (stack);

CREATE INDEX IF NOT EXISTS idx_vacancies_tags
    ON vacancies USING gin (tags);

CREATE INDEX IF NOT EXISTS idx_vacancies_published
    ON vacancies (published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_vacancies_salary
    ON vacancies (salary_max DESC NULLS LAST)
    WHERE salary_max IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vacancies_active
    ON vacancies (status)
    WHERE status IN ('new', 'viewed');

-- ----------------------------------------------------------------------------
-- 7. ai_instructions - промпты и лимиты стоимости ИИ (конфиг в БД).
--    Воркер читает только is_active = TRUE (RLS + фильтр по scope).
--    max_tokens ограничен 4096, чтобы сбой конфига не сжёг бюджет.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_instructions (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope          TEXT        NOT NULL
                               CHECK (scope IN ('global', 'mail_account',
                                                'category', 'sender')),
    scope_key      TEXT        NOT NULL DEFAULT '',
    prompt         TEXT        NOT NULL DEFAULT '',
    model          TEXT,
    fallback_model TEXT,
    max_tokens     INTEGER     CHECK (max_tokens BETWEEN 64 AND 4096),
    temperature    NUMERIC(3, 2) CHECK (temperature BETWEEN 0 AND 2),
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    priority       SMALLINT    NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_instructions_scope_key UNIQUE (scope, scope_key)
);

COMMENT ON TABLE ai_instructions IS
    'Промпты и лимиты ИИ: model/fallback_model/max_tokens переопределяют конфиг.';

CREATE INDEX IF NOT EXISTS idx_ai_instructions_active
    ON ai_instructions (scope, priority)
    WHERE is_active;

-- ----------------------------------------------------------------------------
-- 8. Триггер updated_at: одна функция на все таблицы с этим столбцом.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mail_accounts_updated_at ON mail_accounts;
CREATE TRIGGER trg_mail_accounts_updated_at
    BEFORE UPDATE ON mail_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_emails_updated_at ON emails;
CREATE TRIGGER trg_emails_updated_at
    BEFORE UPDATE ON emails
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_rzhd_tickets_updated_at ON rzhd_tickets;
CREATE TRIGGER trg_rzhd_tickets_updated_at
    BEFORE UPDATE ON rzhd_tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_vacancies_updated_at ON vacancies;
CREATE TRIGGER trg_vacancies_updated_at
    BEFORE UPDATE ON vacancies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_ai_instructions_updated_at ON ai_instructions;
CREATE TRIGGER trg_ai_instructions_updated_at
    BEFORE UPDATE ON ai_instructions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 9. Ролевая модель: navigator_worker
--
--    * роль создаётся NOLOGIN - пароль выдаётся вне репозитория;
--    * права минимальны: чтение ящиков и промптов, запись в журналы/каналы;
--    * в mail_accounts разрешено обновлять только служебные поля
--      (last_sync_at/last_error/updated_at), но не email и не пароль-ключ;
--    * BYPASSRLS не выдаётся никогда - иначе воркер увидит выключенные ящики.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'navigator_worker') THEN
        CREATE ROLE navigator_worker NOLOGIN;
    END IF;
END;
$$;

COMMENT ON ROLE navigator_worker IS
    'Служебная роль Python-воркеров: least privilege + Row-Level Security.';

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO navigator_worker', current_database());
END;
$$;

GRANT USAGE ON SCHEMA public TO navigator_worker;

GRANT SELECT ON mail_accounts TO navigator_worker;
GRANT UPDATE (last_sync_at, last_error, updated_at)
    ON mail_accounts TO navigator_worker;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON mail_folders, emails, valuable_spam, vacancies, rzhd_tickets
    TO navigator_worker;

GRANT SELECT ON ai_instructions TO navigator_worker;

-- Identity-последовательности: без них INSERT ... DEFAULT упадёт.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO navigator_worker;

-- ----------------------------------------------------------------------------
-- 10. Row-Level Security
--
-- Политики для дочерних таблиц используют подзапрос к mail_accounts. Для роли
-- navigator_worker к этому подзапросу тоже применяется RLS, поэтому цепочка
-- «активный ящик -> его письма/папки/полезный спам» работает автоматически.
-- ----------------------------------------------------------------------------
ALTER TABLE mail_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_accounts_worker_select_active ON mail_accounts;
CREATE POLICY mail_accounts_worker_select_active
    ON mail_accounts
    FOR SELECT
    TO navigator_worker
    USING (is_active);

DROP POLICY IF EXISTS mail_accounts_worker_update_active ON mail_accounts;
CREATE POLICY mail_accounts_worker_update_active
    ON mail_accounts
    FOR UPDATE
    TO navigator_worker
    USING (is_active)
    WITH CHECK (is_active);

ALTER TABLE mail_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_folders_worker_active_account ON mail_folders;
CREATE POLICY mail_folders_worker_active_account
    ON mail_folders
    FOR ALL
    TO navigator_worker
    USING (account_id IN (SELECT id FROM mail_accounts))
    WITH CHECK (account_id IN (SELECT id FROM mail_accounts));

ALTER TABLE emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS emails_worker_active_account ON emails;
CREATE POLICY emails_worker_active_account
    ON emails
    FOR ALL
    TO navigator_worker
    USING (account_id IN (SELECT id FROM mail_accounts))
    WITH CHECK (account_id IN (SELECT id FROM mail_accounts));

ALTER TABLE valuable_spam ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS valuable_spam_worker_active_account ON valuable_spam;
CREATE POLICY valuable_spam_worker_active_account
    ON valuable_spam
    FOR ALL
    TO navigator_worker
    USING (account_id IN (SELECT id FROM mail_accounts))
    WITH CHECK (account_id IN (SELECT id FROM mail_accounts));

-- Вакансии: воркер работает только с «живыми» строками. Архивирование -
-- операция владельца/админа, поэтому status = 'archived' скрыт политикой.
ALTER TABLE vacancies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vacancies_worker_active ON vacancies;
CREATE POLICY vacancies_worker_active
    ON vacancies
    FOR ALL
    TO navigator_worker
    USING (status <> 'archived')
    WITH CHECK (status <> 'archived');

-- Билеты: политика-«окно хранения» не даёт воркеру читать/писать рейсы,
-- которые вышли за пределы окна каникул более чем на 30 дней.
ALTER TABLE rzhd_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rzhd_tickets_worker_window ON rzhd_tickets;
CREATE POLICY rzhd_tickets_worker_window
    ON rzhd_tickets
    FOR ALL
    TO navigator_worker
    USING (trip_window_end IS NULL
           OR trip_window_end >= CURRENT_DATE - INTERVAL '30 days')
    WITH CHECK (trip_window_end IS NULL
                OR trip_window_end >= CURRENT_DATE - INTERVAL '30 days');

-- Промпты: воркер видит только включённые инструкции.
ALTER TABLE ai_instructions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_instructions_worker_select_active ON ai_instructions;
CREATE POLICY ai_instructions_worker_select_active
    ON ai_instructions
    FOR SELECT
    TO navigator_worker
    USING (is_active);

-- ----------------------------------------------------------------------------
-- 11. Сид: основной ящик oshkines@mail.ru и лимиты классификатора.
--     Пароль и логин лежат в .env: ENV_MAIL_PRIMARY_USERNAME /
--     ENV_MAIL_PRIMARY_PASSWORD. В таблице - только имена переменных.
-- ----------------------------------------------------------------------------
INSERT INTO mail_accounts (
    label, email, imap_host, imap_port, use_ssl, mailbox,
    env_password_key, username_env_key,
    poll_interval_sec, max_messages_per_poll, is_active
)
VALUES (
    'Main Mail.ru mailbox',
    'oshkines@mail.ru',
    'imap.mail.ru',
    993,
    TRUE,
    'INBOX',
    'ENV_MAIL_PRIMARY_PASSWORD',
    'ENV_MAIL_PRIMARY_USERNAME',
    120,
    10,
    TRUE
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO ai_instructions (scope, scope_key, prompt, model, fallback_model,
                             max_tokens, temperature, is_active, priority)
VALUES (
    'global',
    'classifier',
    'Classify the incoming email into WHITELIST | CRITICAL | VACANCY | SPAM_VALUABLE | SPAM.',
    'deepseek-chat',
    'deepseek-reasoner',
    400,
    0.10,
    TRUE,
    10
)
ON CONFLICT (scope, scope_key) DO NOTHING;

INSERT INTO ai_instructions (scope, scope_key, prompt, model, fallback_model,
                             max_tokens, temperature, is_active, priority)
VALUES (
    'global',
    'summarizer',
    'Summarize the email in 3-5 bullet points: facts, deadlines, amounts, actions.',
    'deepseek-reasoner',
    'deepseek-chat',
    700,
    0.20,
    TRUE,
    20
)
ON CONFLICT (scope, scope_key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 12. Отметка о применении миграции
-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, description)
VALUES ('001_init_schema',
        'Initial schema: 7 tables, indexes, triggers, navigator_worker role, RLS')
ON CONFLICT (version) DO NOTHING;

COMMIT;




