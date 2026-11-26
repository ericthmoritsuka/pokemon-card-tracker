#!/usr/bin/env bash
# Runs every store script and supabase/store-order-stages.sql (with reruns,
# and an older script run again afterwards) against a throwaway Postgres
# container, then checks the order checklist's ticks and the delivered list
# as the owner, a member, and a visitor
# (tests/store-order-stages-sql-check.sql). Needs Docker or Podman. Nothing
# touches the real Supabase project. The first errors it prints, "Run
# supabase/store-bundles.sql first" and "current transaction is aborted",
# are the refusal it checks for; a failed check stops the run before the
# closing line.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

engine="$(command -v docker || command -v podman)"
name="card-tracker-order-stages-check-$$"

"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null
trap '"${engine}" stop "${name}" >/dev/null' EXIT

until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
do
	sleep 1
done

"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests

for file in setup store store-orders store-sealed store-bundles store-order-stages
do
	"${engine}" cp "supabase/${file}.sql" "${name}:/check/supabase/${file}.sql"
done

"${engine}" cp tests/store-order-stages-sql-check.sql "${name}:/check/tests/store-order-stages-sql-check.sql"
"${engine}" exec "${name}" psql --quiet --username=postgres --file=/check/tests/store-order-stages-sql-check.sql

echo "store-order-stages: all checks passed"
