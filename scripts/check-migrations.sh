#!/usr/bin/env bash
set -euo pipefail

base=${1:?Usage: bash scripts/check-migrations.sh BASE_SHA}
# Disable rename detection so moving a migration is reported as a deletion.
if git diff --quiet --no-ext-diff --no-renames --diff-filter=DMRTUXB "$base" HEAD -- server/migrations/; then
  exit 0
else
  status=$?
  if [ "$status" -ne 1 ]; then
    exit "$status"
  fi
fi
echo 'Existing migrations are append-only; add a new migration instead.' >&2
git diff --no-ext-diff --no-renames --name-status --diff-filter=DMRTUXB "$base" HEAD -- server/migrations/ >&2
exit 1
