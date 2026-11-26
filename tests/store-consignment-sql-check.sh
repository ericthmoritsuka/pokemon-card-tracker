#!/usr/bin/env bash
# Runs every store script and supabase/store-consignment.sql (with reruns)
# against a throwaway Postgres container, and checks consignment as the
# owner, a member, and a visitor (tests/store-consignment-sql-check.sql).
# Needs Docker or Podman. Nothing touches the real Supabase project.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

engine="$(command -v docker || command -v podman)"
name="card-tracker-consignment-check-$$"

"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null
trap '"${engine}" stop "${name}" >/dev/null' EXIT

until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
do
	sleep 1
done

"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests

for file in setup store store-orders store-sealed store-bundles store-own-pictures store-withdraw store-consignment
do
	"${engine}" cp "supabase/${file}.sql" "${name}:/check/supabase/${file}.sql"
done

"${engine}" cp tests/store-consignment-sql-check.sql "${name}:/check/tests/store-consignment-sql-check.sql"
"${engine}" exec "${name}" psql --quiet --tuples-only --username=postgres --file=/check/tests/store-consignment-sql-check.sql
