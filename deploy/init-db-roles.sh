#!/usr/bin/env bash
set -euo pipefail
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD must be nonempty}"
case "${1-}" in
    --external)
        : "${PGSERVICE:?Set PGSERVICE to the external database service}"
        : "${FUKULOW_DB_OWNER:?Set FUKULOW_DB_OWNER to the migration owner}"
        export PGSSLMODE="${PGSSLMODE:-verify-full}"
        cd -- "$(dirname -- "$0")"
        (
            unset POSTGRES_APP_PASSWORD PGPASSWORD PGPASSFILE
            # Override service and default passfiles. The readiness probe can reach
            # a password-authenticated server without supplying a password.
            preflight="passfile=/dev/null/pgpass password=''"
            pg_isready -q -d "$preflight" || psql -X -w -d "$preflight" -c 'SELECT 1' >/dev/null
        )
        ;;
    '')
        cd /opt/fukulow
        export PGUSER="${POSTGRES_USER:?}" PGDATABASE="${POSTGRES_DB:?}" FUKULOW_DB_OWNER="$POSTGRES_USER"
        ;;
    *) echo 'Usage: init-db-roles.sh [--external]' >&2; exit 2 ;;
esac
# psql's quoted variable syntax escapes SQL literals, including quotes/backslashes.
# Keep all diagnostics private: server error context can contain a role password.
if ! psql -X -w -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
\i db-role-settings.sql
\getenv app_password POSTGRES_APP_PASSWORD
SELECT set_config('fukulow.app_password', :'app_password', true);
\i db-roles.sql
-- Default privileges must belong to the role that will create objects.
\getenv migration_owner FUKULOW_DB_OWNER
SET LOCAL ROLE :"migration_owner";
\i db-grants.sql
COMMIT;
SQL
then
    echo 'Database roles initialization failed (diagnostics suppressed)' >&2
    exit 1
fi
