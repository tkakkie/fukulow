-- The caller sets this transaction-local value through a bound/quoted parameter.
DO $$
BEGIN
    IF coalesce(current_setting('fukulow.app_password', true), '') = '' THEN
        RAISE EXCEPTION 'POSTGRES_APP_PASSWORD must be nonempty';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_app') THEN
        CREATE ROLE fukulow_app;
    END IF;
    -- Never reassign/drop existing objects or silently retain role memberships.
    IF EXISTS (SELECT FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
               AND refobjid = 'fukulow_app'::regrole AND deptype = 'o')
       OR EXISTS (SELECT FROM pg_auth_members WHERE member = 'fukulow_app'::regrole) THEN
        RAISE EXCEPTION 'fukulow_app must own no objects and have no role memberships';
    END IF;
    ALTER ROLE fukulow_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOINHERIT NOREPLICATION NOBYPASSRLS;
    -- Utility statements cannot bind parameters. PostgreSQL quotes the value as
    -- a literal; callers never construct SQL containing the password.
    EXECUTE format('ALTER ROLE fukulow_app PASSWORD %L VALID UNTIL ''infinity''',
                   current_setting('fukulow.app_password'));
END $$;
