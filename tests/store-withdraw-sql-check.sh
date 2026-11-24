#!/usr/bin/env bash
# Runs supabase/setup.sql, supabase/store.sql, and supabase/store-withdraw.sql
# (twice) against a throwaway Postgres container, then checks store_withdraw
# as the owner, a member, and a visitor (tests/store-withdraw-sql-check.sql).
# Needs Docker or Podman. Nothing touches the real Supabase project.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

engine="$(command -v docker || command -v podman)"
name="card-tracker-withdraw-check-$$"

"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null
trap '"${engine}" stop "${name}" >/dev/null' EXIT

until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
do
	sleep 1
done

"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests
"${engine}" cp supabase/setup.sql "${name}:/check/supabase/setup.sql"
"${engine}" cp supabase/store.sql "${name}:/check/supabase/store.sql"
"${engine}" cp supabase/store-withdraw.sql "${name}:/check/supabase/store-withdraw.sql"
"${engine}" cp tests/store-withdraw-sql-check.sql "${name}:/check/tests/store-withdraw-sql-check.sql"
"${engine}" exec "${name}" psql --quiet --username=postgres --file=/check/tests/store-withdraw-sql-check.sql
