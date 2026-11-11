DO $$
BEGIN
    EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM fukulow_app', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO fukulow_app', current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM fukulow_app;
GRANT USAGE ON SCHEMA public TO fukulow_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fukulow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fukulow_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM fukulow_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO fukulow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM fukulow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fukulow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM fukulow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO fukulow_app;
-- SQLx creates its bookkeeping table after initdb; reapply after migrations.
DO $$
BEGIN
    IF to_regclass('public._sqlx_migrations') IS NOT NULL THEN
        REVOKE ALL ON public._sqlx_migrations FROM fukulow_app;
        GRANT SELECT ON public._sqlx_migrations TO fukulow_app;
    END IF;
END $$;
