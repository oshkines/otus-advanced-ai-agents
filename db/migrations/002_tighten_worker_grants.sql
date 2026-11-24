-- ============================================================================
-- 002_tighten_worker_grants.sql
--
-- Выравнивает права роли navigator_worker до модели least privilege из
-- architecture.md §5 / §13.4. Причина: на стенде роль получила широкие
-- табличные гранты (INSERT/SELECT/UPDATE на все колонки mail_accounts,
-- права на schema_migrations, DELETE на журналы), из-за чего воркер мог
-- переписать адрес ящика/ключ пароля и вставлять строки в журнал миграций.
--
-- Кто применяет: ВЛАДЕЛЕЦ БД (postgres). Роль navigator_worker применить
-- этот скрипт не может: REVOKE/GRANT от не-владельца не отзывают чужие
-- гранты (PostgreSQL выдаёт только WARNING, ACL не меняется).
--
-- Скрипт идемпотентен: повторный запуск ничего не ломает.
--
--   psql "postgresql://postgres:<admin-password>@<host>:5432/ai_dev_navigator" \
--        -v ON_ERROR_STOP=1 -f db/migrations/002_tighten_worker_grants.sql
-- ============================================================================

BEGIN;

-- 1. Снять всё, что выдано сверх модели прав -------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM navigator_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM navigator_worker;

-- 2. Вернуть ровно права из 001_init_schema.sql §9 -------------------------

-- mail_accounts: читаем всё, пишем только служебный статус.
-- Колоночный GRANT UPDATE не даёт менять email, imap_host, env_password_key,
-- is_active - попытка вернёт 42501 permission denied.
GRANT SELECT ON mail_accounts TO navigator_worker;
GRANT UPDATE (last_sync_at, last_error, updated_at)
    ON mail_accounts TO navigator_worker;

-- mail_folders: --sync-folders пересобирает снимок папок (UPSERT + cleanup).
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_folders TO navigator_worker;

-- Журналы и каналы воркеров: пишем, но не удаляем записи.
GRANT SELECT, INSERT, UPDATE
    ON emails, valuable_spam, vacancies, rzhd_tickets TO navigator_worker;

-- Промпты: только чтение (менять лимиты может владелец).
GRANT SELECT ON ai_instructions TO navigator_worker;

-- schema_migrations: прав не выдаём (служебная таблица миграций).

-- 3. Identity-последовательности: без них INSERT ... DEFAULT падает -------
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO navigator_worker;

-- 4. Фиксация миграции -----------------------------------------------------
INSERT INTO schema_migrations (version, description)
VALUES ('002_tighten_worker_grants', 'Least privilege for navigator_worker: column-level UPDATE on mail_accounts, no DELETE on journals, no rights on schema_migrations')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ============================================================================
-- 5. Проверка (выполнить после COMMIT) - ожидаемые ответы:
--
--   SELECT privilege_type, column_name
--   FROM information_schema.column_privileges
--   WHERE grantee = 'navigator_worker' AND table_name = 'mail_accounts'
--   ORDER BY 1, 2;
--     -> SELECT по всем 16 колонкам + UPDATE только last_sync_at, last_error,
--        updated_at (DELETE отсутствует)
--
--   Под ролью воркера:
--   SET ROLE navigator_worker;
--   UPDATE mail_accounts SET email = email;              -- 42501
--   UPDATE mail_accounts SET is_active = FALSE;          -- 42501
--   DELETE FROM mail_accounts;                           -- 42501
--   INSERT INTO schema_migrations(version, description)  -- 42501
--     VALUES ('probe', 'probe');
--   UPDATE mail_accounts SET last_error = last_error;    -- UPDATE 1 (разрешено)
--   RESET ROLE;
-- ============================================================================
