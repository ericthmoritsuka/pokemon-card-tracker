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

# run_check <hardening file>: one throwaway container, every store script,
# then the checks. Prints psql's output; fails when a check fails.
run_check() {
	local hardening="$1"
	local name="card-tracker-hardening-check-$$-${RANDOM}"

	"${engine}" run --detach --env POSTGRES_PASSWORD=check --name "${name}" --rm postgres:17-alpine >/dev/null

	until "${engine}" exec "${name}" pg_isready --username=postgres >/dev/null 2>&1
	do
		sleep 1
	done

	"${engine}" exec "${name}" mkdir -p /check/supabase /check/tests

	for file in setup store store-orders store-sealed store-withdraw store-own-pictures store-featured store-blog store-bundles store-consignment store-order-stages store-consignment-delete
	do
		"${engine}" cp "supabase/${file}.sql" "${name}:/check/supabase/${file}.sql"
	done

	"${engine}" cp "${hardening}" "${name}:/check/supabase/store-hardening.sql"
	"${engine}" cp tests/store-hardening-sql-check.sql "${name}:/check/tests/store-hardening-sql-check.sql"

	local status=0

	"${engine}" exec "${name}" psql --quiet --tuples-only --username=postgres --file=/check/tests/store-hardening-sql-check.sql || status=$?
	"${engine}" stop "${name}" >/dev/null

	return "${status}"
}

run_check supabase/store-hardening.sql

# Mutation check (v128 review H1): with the reserved and sold copies no
# longer counted as leaving, the checks must fail on the H1 line, so they
# do test the fix.
mutant="$(mktemp)"
trap 'rm -f "${mutant}"' EXIT
sed 's/and live ? l\.id;/and false;/' supabase/store-hardening.sql >"${mutant}"

if cmp --silent supabase/store-hardening.sql "${mutant}"
then
	echo "mutation check: the line to mutate was not found" >&2
	exit 1
fi

if output="$(run_check "${mutant}" 2>&1)"
then
	echo "mutation check: the checks passed without the H1 fix" >&2
	exit 1
fi

if ! grep --quiet "FAIL: H1" <<<"${output}"
then
	echo "mutation check: failed, but not on H1:" >&2
	echo "${output}" | tail -n 5 >&2
	exit 1
fi

echo 'store-hardening: the mutation check failed on H1, as it should'
