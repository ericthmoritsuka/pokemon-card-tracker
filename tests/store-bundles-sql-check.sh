#!/usr/bin/env bash
# Runs every store script and supabase/store-bundles.sql (with reruns)
# against a throwaway Postgres container, checks kits as the owner, a member,
# and a visitor (tests/store-bundles-sql-check.sql), then races a kit and a
# single that share a copy over two connections, both ways round. Needs
# Docker or Podman. Nothing touches the real Supabase project.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

engine="$(command -v docker || command -v podman)"
name="card-tracker-bundles-check-$$"

"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null
trap '"${engine}" stop "${name}" >/dev/null' EXIT

until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
do
	sleep 1
done

"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests

for file in setup store store-orders store-sealed store-bundles
do
	"${engine}" cp "supabase/${file}.sql" "${name}:/check/supabase/${file}.sql"
done

"${engine}" cp tests/store-bundles-sql-check.sql "${name}:/check/tests/store-bundles-sql-check.sql"
"${engine}" exec "${name}" psql --quiet --username=postgres --file=/check/tests/store-bundles-sql-check.sql

psql_check() {
	"${engine}" exec -i "${name}" psql --no-align --quiet --tuples-only --username=postgres "$@"
}

psql_check --command="
	update public.store_listings set status = 'available', order_id = null;
	insert into public.store_bundles (id, name, price_mode, discount_pct) values ('20000000-0000-0000-0000-000000000001', 'Race kit', 'percent', 5);
	insert into public.store_bundle_items values ('20000000-0000-0000-0000-000000000001', 'c-spr', 1), ('20000000-0000-0000-0000-000000000001', 'c-fue', 2);" >/dev/null

kit="array['20000000-0000-0000-0000-000000000001'::uuid]"

# The kit closes first and holds its rows; a single for one of its copies
# waits, then finds it taken.
psql_check --command="begin; set local role anon; select public.place_order(null, 'Kit first', '81', null, ${kit}); select pg_sleep(2); commit;" >/dev/null &
sleep 1
single="$(psql_check --command="set role anon; select public.place_order(array['c-spr'], 'Single second', '81')")"
wait

if [[ "${single}" != *'"unavailable": ["c-spr"]'* ]]
then
	echo "FAIL: a single after the kit got ${single}"

	exit 1
fi

psql_check --command="update public.store_listings set status = 'available', order_id = null" >/dev/null

# The single closes first; the kit waits, is refused by its ID, and reserves
# none of its cards.
psql_check --command="begin; set local role anon; select public.place_order(array['c-fue'], 'Single first', '81'); select pg_sleep(2); commit;" >/dev/null &
sleep 1
kit_result="$(psql_check --command="set role anon; select public.place_order(null, 'Kit second', '81', null, ${kit})")"
wait

if [[ "${kit_result}" != *'"unavailable_kits": ["20000000-0000-0000-0000-000000000001"]'* ]]
then
	echo "FAIL: the kit after a single got ${kit_result}"

	exit 1
fi

if [[ "$(psql_check --command="select status from public.store_listings where id = 'c-spr'")" != 'available' ]]
then
	echo 'FAIL: the refused kit reserved Sprigatito'

	exit 1
fi

echo 'store-bundles.sql: all checks passed, and the race holds both ways.'
