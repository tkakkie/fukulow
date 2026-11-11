-- Run before sending any password. Insufficient privileges fail closed here;
-- the role-normalization step already requires a superuser (NOSUPERUSER, etc.).
SET LOCAL log_statement = 'none';
-- Also covers already-sampled transactions, debug output and error CONTEXT.
SET LOCAL log_min_messages = 'panic';
SET LOCAL log_parameter_max_length = 0;
SET LOCAL log_parameter_max_length_on_error = 0;
DO $$
BEGIN
    -- The extension need not be installed/preloaded in ordinary deployments.
    IF current_setting('pg_stat_statements.track', true) IS NOT NULL THEN
        PERFORM set_config('pg_stat_statements.track', 'top', true);
    END IF;
END $$;
