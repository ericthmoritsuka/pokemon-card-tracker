#!/usr/bin/env bash
# Runs every store script in the order Eric ran them, then
# supabase/store-hardening.sql twice, against a throwaway Postgres container,
# and checks each review fix (H1, H2, H3, M4, M5, M6) failing before and
# passing after (tests/store-hardening-sql-check.sql). Needs Docker or
# Podman. Nothing touches the real Supabase project. The errors it prints
# from store-orders.sql ("store-hardening.sql has run") are the refusal it
# checks for; a failed check stops the run before the closing line.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

engine="$(command -v docker || command -v podman)"
name="card-tracker-hardening-check-$$"

"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null
trap '"${engine}" stop "${name}" >/dev/null' EXIT

until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
do
	sleep 1
done

"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests

for file in setup store store-orders store-sealed store-withdraw store-own-pictures store-featured store-blog store-bundles store-consignment store-order-stages store-consignment-delete store-hardening
do
	"${engine}" cp "supabase/${file}.sql" "${name}:/check/supabase/${file}.sql"
done

"${engine}" cp tests/store-hardening-sql-check.sql "${name}:/check/tests/store-hardening-sql-check.sql"
"${engine}" exec "${name}" psql --quiet --tuples-only --username=postgres --file=/check/tests/store-hardening-sql-check.sql
