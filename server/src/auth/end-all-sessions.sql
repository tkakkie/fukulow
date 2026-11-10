-- Offline recovery only: stop every app instance first. This is intentionally global.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DELETE FROM public.account_sessions;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.account_sessions) THEN
        RAISE EXCEPTION 'Account Sessions remain; keep the application stopped';
    END IF;
END $$;
COMMIT;
