#!/usr/bin/env bash
set -euo pipefail
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD must be nonempty}"
# psql's quoted variable syntax escapes SQL literals, including quotes/backslashes.
# Keep all diagnostics private: server error context can contain a role password.
if ! psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
\getenv app_password POSTGRES_APP_PASSWORD
SELECT set_config('fukulow.app_password', :'app_password', true);
\i /opt/fukulow/db-roles.sql
\i /opt/fukulow/db-grants.sql
COMMIT;
SQL
then
    echo 'Database roles initialization failed (diagnostics suppressed)' >&2
    exit 1
fi
