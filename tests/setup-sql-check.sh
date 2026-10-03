#!/usr/bin/env bash
# Runs supabase/setup.sql (and the optional supabase/min-client.sql) twice
# against a throwaway Postgres container, then
# checks its row-level security and functions as three made-up users
# (tests/setup-sql-check.sql). Needs Docker or Podman. Nothing touches the
# real Supabase project.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

engine="$(command -v docker || command -v podman)"
name="card-tracker-sql-check-$$"

"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null
trap '"${engine}" stop "${name}" >/dev/null' EXIT

until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
do
	sleep 1
done

"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests
"${engine}" cp supabase/setup.sql "${name}:/check/supabase/setup.sql"
"${engine}" cp supabase/min-client.sql "${name}:/check/supabase/min-client.sql"
"${engine}" cp tests/setup-sql-check.sql "${name}:/check/tests/setup-sql-check.sql"
"${engine}" exec "${name}" psql --quiet --username=postgres --file=/check/tests/setup-sql-check.sql
