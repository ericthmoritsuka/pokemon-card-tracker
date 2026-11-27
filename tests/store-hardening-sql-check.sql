-- Checks supabase/store-hardening.sql (H1, H2, H3, M4, M5, and M6 of the
-- HOTARU principal engineer review) against plain Postgres. It runs every
-- store script in the order Eric ran them, shows each defect on that chain
-- (inside a transaction that is rolled back), runs the hardening file twice,
-- shows each defect gone, and then checks that an older script refuses to
-- run over it. The stand-in for Supabase's auth and storage is the one in
-- tests/store-consignment-sql-check.sql. Run by
-- tests/store-hardening-sql-check.sh. Every check raises on failure, so a
-- clean run means all passed.

\set ON_ERROR_STOP on
\o /dev/null
set client_min_messages = warning;

create role anon nologin;
create role authenticated nologin;
create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
	$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant all on storage.objects to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;

insert into auth.users values ('00000000-0000-0000-0000-00000000000a', 'owner@example.test');

-- The live chain, in the order Eric ran it (git log of supabase/).
\ir ../supabase/setup.sql
\ir ../supabase/store.sql
\ir ../supabase/store-orders.sql
\ir ../supabase/store-sealed.sql
\ir ../supabase/store-withdraw.sql
\ir ../supabase/store-own-pictures.sql
\ir ../supabase/store-featured.sql
\ir ../supabase/store-blog.sql
\ir ../supabase/store-bundles.sql
\ir ../supabase/store-consignment.sql
\ir ../supabase/store-order-stages.sql
\ir ../supabase/store-consignment-delete.sql

create schema t;
grant usage on schema t to anon, authenticated;
create function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin
	if cond is not true then raise exception 'FAIL: %', label; end if;
end $$;
create function t.err(stmt text, code text, label text) returns void language plpgsql as $$
begin
	execute stmt;
	raise exception 'FAIL (no error): %', label;
exception when others then
	if sqlstate = code then null;
	elsif sqlerrm like 'FAIL%' then raise;
	else raise exception 'FAIL: % got % %', label, sqlstate, sqlerrm; end if;
end $$;
grant execute on all functions in schema t to anon, authenticated;
create table t.v (k text primary key, j jsonb);
grant all on t.v to anon, authenticated;
-- Listing IDs c001 to c080, R$ 5 each.
create function t.cards(a int, b int) returns text[] language sql immutable as
	$$ select array_agg('c' || lpad(n::text, 3, '0') order by n) from generate_series(a, b) n $$;
grant execute on function t.cards(int, int) to anon, authenticated;
-- One available ETB unit, read as the test's own user.
create function t.unit() returns text language sql stable security definer as
	$$ select l.id from public.store_listings l where l.card_id = (select j ->> 'id' from t.v where k = 'etb') and l.status = 'available' order by l.id limit 1 $$;
grant execute on function t.unit() to anon, authenticated;

insert into public.groups (id, name, owner_id) values ('10000000-0000-0000-0000-000000000000', 'Fam', '00000000-0000-0000-0000-00000000000a');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select public.store_sync((
	select jsonb_agg(jsonb_build_object('id', 'c' || lpad(n::text, 3, '0'), 'card_id', 'x-' || n, 'catalog', 'international', 'language', 'en', 'name', 'Card ' || n, 'price_brl', 5))
	from generate_series(1, 80) n
));
insert into t.v select 'etb', public.save_product('{"name": "ETB", "price_brl": 300, "quantity": 2}');
reset role;
reset request.jwt.claim.sub;

-- ============================================== before: the defects exist

begin;

-- H1: one phone, three orders, nothing stops it.
set local role anon;
select public.place_order(t.cards(1, 20), 'x', 'x');
select public.place_order(t.cards(21, 40), 'x', 'x');
select t.ok(public.place_order(t.cards(41, 60), 'x', 'x') ? 'code', 'before H1: one phone holds 60 cards');
reset role;

-- H2: order 10000 gets HTR-1000, and a failed order uses a number.
select setval('public.store_order_number', 9999);
set local role anon;
select t.ok(public.place_order(t.cards(61, 61), 'y', 'y') ->> 'code' = 'HTR-1000', 'before H2: order 10000 is cut to HTR-1000');
select t.err($$select public.place_order('{nope}', 'y', 'y')$$, '23505', 'before H2: order 10001 collides with HTR-1000 and breaks checkout');
reset role;
select t.ok((select last_value from public.store_order_number) = 10001, 'before H2: the failed order used a number');
select setval('public.store_order_number', 100);

-- H3: a buyer reserves one ETB, then a stale form saves quantity 2.
set local role anon;
select public.place_order(array[t.unit()], 'z', 'z');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t.ok((public.save_product((select jsonb_build_object('id', j ->> 'id', 'name', 'ETB', 'price_brl', 300, 'quantity', 2, 'description', 'typo fixed') from t.v where k = 'etb')) ->> 'available')::int = 2,
	'before H3: a stale save brings the reserved unit back as a new one');
reset role;

-- M4 and M5: a fourth receipt goes in, and a receipt does not move the deadline.
insert into t.v select 'm', public.place_order(t.cards(62, 62), 'w', 'w');
update public.store_orders set reserved_until = now() + interval '1 hour' where code = (select j ->> 'code' from t.v where k = 'm');
set local role anon;
insert into storage.objects (bucket_id, name) select 'store-receipts', (j ->> 'receipt_token') || '/r' || n || '.jpg' from t.v, generate_series(1, 4) n where k = 'm';
select public.attach_receipt((j ->> 'receipt_token')::uuid, (j ->> 'receipt_token') || '/r4.jpg') from t.v where k = 'm';
reset role;
select t.ok((select count(*) from storage.objects where name like (select j ->> 'receipt_token' from t.v where k = 'm') || '/%') = 4, 'before M5: a fourth receipt is taken');
select t.ok((select reserved_until < now() + interval '2 hours' from public.store_orders where code = (select j ->> 'code' from t.v where k = 'm')), 'before M4: a receipt leaves the deadline at one hour');

rollback;

-- ================================================ the fix, run twice

\ir ../supabase/store-hardening.sql
\ir ../supabase/store-hardening.sql

select t.ok(private.store_verify() = 'store ok', 'store_verify passes after the hardening');
select setval('public.store_order_number', 9998);

-- ============================================================ after: H1

set role anon;
set request.headers = '{"x-forwarded-for": "203.0.113.7, 10.0.0.1"}';

-- The honest path still works.
insert into t.v select 'h1', public.place_order(t.cards(1, 2), 'Ana', '(81) 9 9999-0000');
select t.ok((select j ? 'receipt_token' and j ->> 'code' = 'HTR-9999' from t.v where k = 'h1'), 'an honest order goes through, with the same return shape');

-- Per phone: the same number typed another way is the same phone.
reset request.headers;
select public.place_order(t.cards(3, 3), 'Ana', '81999990000');
select t.err($$select public.place_order(t.cards(4, 4), 'Ana', '81 99999 0000')$$, '22023', 'H1: a third pending order from one phone is refused');

-- Per client: two orders from one address, a third refused even with a new phone.
set request.headers = '{"x-forwarded-for": "198.51.100.9"}';
select public.place_order(t.cards(5, 5), 'B', '1');
select public.place_order(t.cards(6, 6), 'B', '2');
select t.err($$select public.place_order(t.cards(7, 7), 'B', '3')$$, '22023', 'H1: a third pending order from one client is refused');
reset request.headers;
reset role;
select t.ok((select count(*) = 0 from public.store_orders where client_key like '%198.51.100.9%'), 'H1: the client key is a hash, not the address');

-- Global: pending orders hold at most 60 cards (5 held now).
set role anon;
select public.place_order(t.cards(10, 29), 'C', 'c1');
select public.place_order(t.cards(30, 49), 'C', 'c2');
select t.err($$select public.place_order(t.cards(50, 65), 'D', 'd1')$$, '22023', 'H1: an order past 60 reserved cards is refused');
select t.ok(public.place_order(t.cards(50, 64), 'D', 'd1') ? 'code', 'H1: an order up to exactly 60 cards goes through');
select t.err($$select public.place_order(t.cards(70, 70), 'E', 'e1')$$, '22023', 'H1: the 61st card is refused');

-- Eric cancels one, and orders flow again.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select public.cancel_order((select j ->> 'code' from t.v where k = 'h1'));
set role anon;
reset request.jwt.claim.sub;
select t.ok(public.place_order(t.cards(70, 70), 'E', 'e1') ? 'code', 'H1: a cancelled order frees room');
reset role;

-- ============================================================ after: H2

select t.ok((select count(*) from public.store_orders where code = 'HTR-10000') = 1, 'H2: order 10000 is HTR-10000');
select t.ok((select count(*) from public.store_orders where code = 'HTR-1000') = 0, 'H2: nothing is cut to HTR-1000');

-- Free the cap for the rest of the checks.
update public.store_orders set status = 'cancelled', ended_at = now() where status = 'pending';
update public.store_listings set status = 'available', order_id = null where status = 'reserved';

select setval('public.store_order_number', 10010);
set role anon;
select public.place_order('{nope}', 'y', 'y');
select public.place_order(t.cards(2, 2), 'y', 'y1');
select public.place_order(array['c002', 'c003'], 'y', 'y2');
reset role;
select t.ok((select last_value from public.store_order_number) = 10011, 'H2: failed orders (unknown ID, card taken) use no number');

-- A code taken another way is skipped, not collided with.
insert into public.store_orders (code, name, phone, total, reserved_until, status) values ('HTR-10012', 'old', 'old', 1, now(), 'cancelled');
set role anon;
select t.ok(public.place_order(t.cards(4, 4), 'y', 'y3') ->> 'code' = 'HTR-10013', 'H2: an existing code is skipped');
reset role;

-- ============================================================ after: H3

set role anon;
select public.place_order(array[t.unit()], 'z', 'z');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t.ok((public.save_product((select jsonb_build_object('id', j ->> 'id', 'name', 'ETB', 'price_brl', 300, 'quantity', 2, 'expected_available', 2, 'description', 'typo fixed') from t.v where k = 'etb')) ->> 'available')::int = 1,
	'H3: a stale form that left the quantity alone keeps the 1 unit left');
select t.ok((public.save_product((select jsonb_build_object('id', j ->> 'id', 'name', 'ETB', 'price_brl', 300, 'quantity', 3, 'expected_available', 2) from t.v where k = 'etb')) ->> 'available')::int = 2,
	'H3: a stale form that adds one adds one to what is left');
select t.ok((public.save_product((select jsonb_build_object('id', j ->> 'id', 'name', 'ETB', 'price_brl', 300, 'quantity', 0, 'expected_available', 5) from t.v where k = 'etb')) ->> 'available')::int = 0,
	'H3: never below zero');
select t.ok((public.save_product((select jsonb_build_object('id', j ->> 'id', 'name', 'ETB', 'price_brl', 300, 'quantity', 2) from t.v where k = 'etb')) ->> 'available')::int = 2,
	'H3: the old admin call (no expected_available) still sets the count');
select t.ok((public.save_product((select jsonb_build_object('id', j ->> 'id', 'name', 'ETB', 'price_brl', 300, 'quantity', 2, 'expected_available', 2, 'active', false) from t.v where k = 'etb')) ->> 'available')::int = 0,
	'H3: inactive still offers no unit');
select t.ok((public.save_product('{"name": "New box", "price_brl": 10, "quantity": 3}') ->> 'available')::int = 3, 'H3: a new product gets its quantity');
reset role;
reset request.jwt.claim.sub;

-- ====================================================== after: M4 and M5

set role anon;
insert into t.v select 'm', public.place_order(t.cards(40, 40), 'w', 'w');
reset role;
update public.store_orders set reserved_until = now() + interval '1 hour' where code = (select j ->> 'code' from t.v where k = 'm');
set role anon;
insert into storage.objects (bucket_id, name) select 'store-receipts', (j ->> 'receipt_token') || '/r' || n || '.jpg' from t.v, generate_series(1, 3) n where k = 'm';
select t.err(format($$insert into storage.objects (bucket_id, name) values ('store-receipts', '%s/r4.jpg')$$, (select j ->> 'receipt_token' from t.v where k = 'm')), '42501', 'M5: a fourth receipt is refused');
select t.ok(public.attach_receipt((j ->> 'receipt_token')::uuid, (j ->> 'receipt_token') || '/r3.jpg') ? 'receipt_at', 'M5: the last allowed file can still be attached') from t.v where k = 'm';
select t.err($$select public.attach_receipt(gen_random_uuid(), 'x/r.jpg')$$, '22023', 'M5: attach_receipt still refuses a bad path');
reset role;
select t.ok((select reserved_until > now() + interval '47 hours' from public.store_orders where code = (select j ->> 'code' from t.v where k = 'm')), 'M4: a receipt moves the deadline to 48 hours from now');

-- ============================================ after: the listing invariant

-- The owner's document (supabase/setup.sql). Keys are card + language +
-- finish; each copy below is named for the rule it exercises.
insert into public.documents (user_id, doc) values ('00000000-0000-0000-0000-00000000000a', $doc${
	"cards": [
		{"id": "pair-1", "card_id": "sv01-001", "catalog": "international", "language": "en", "variant_id": "holo"},
		{"id": "pair-2", "card_id": "sv01-001", "catalog": "international", "language": "en", "variant_id": "holo"},
		{"id": "lone-rh", "card_id": "sv01-002", "language": "en", "finish_raw": "Reverse Holo"},
		{"id": "lone-rh-normal", "card_id": "sv01-002", "language": "en", "variant_id": "normal"},
		{"id": "unset", "card_id": "sv01-003", "language": "en"},
		{"id": "unset-normal", "card_id": "sv01-003", "language": "en", "variant_id": "normal"},
		{"id": "marked", "card_id": "sv01-004", "language": "en", "variant_id": "holo", "for_sale": true},
		{"id": "marked-held", "card_id": "sv01-005", "language": "en", "for_sale": true},
		{"id": "pocket", "card_id": "sv01-006", "language": "en"},
		{"id": "pocket-loose", "card_id": "sv01-006", "language": "en"},
		{"id": "gone", "card_id": "sv01-007", "language": "en", "deleted_at": "2026-11-26T10:00:00Z"},
		{"id": "gone-twin", "card_id": "sv01-007", "language": "en"},
		{"id": "old-binder", "card_id": "sv01-008", "language": "en"},
		{"id": "old-binder-2", "card_id": "sv01-008", "language": "en"},
		{"id": "pt", "card_id": "sv01-009", "language": "pt"},
		{"id": "pt-en", "card_id": "sv01-009", "language": "en"}
	],
	"binders": [
		{"id": "b1", "name": "Hand", "rows": 3, "cols": 3, "page_count": 2, "slots": [
			{"page": 1, "position": 1, "entry_id": "pocket"},
			{"page": 1, "position": 2, "entry_id": "marked-held"}
		]},
		{"id": "b2", "name": "Gone", "rows": 3, "cols": 3, "page_count": 1, "deleted_at": "2026-11-20T10:00:00Z", "slots": [
			{"page": 1, "position": 1, "entry_id": "old-binder"}
		]}
	]
}$doc$);

create function t.row(id text) returns jsonb language sql immutable as
	$$ select jsonb_build_object('id', id, 'card_id', 'x', 'catalog', 'international', 'language', 'en', 'name', id, 'price_brl', 5) $$;
create function t.sync(ids text[]) returns jsonb language sql as
	$$ select public.store_sync((select coalesce(jsonb_agg(t.row(i) order by o), '[]') from unnest(ids) with ordinality u(i, o))) $$;
create function t.reason(answer jsonb, id text) returns text language sql immutable as
	$$ select s ->> 'reason' from jsonb_array_elements(coalesce(answer -> '_skipped', '[]')) s where s ->> 'id' = id $$;
create function t.verify_error() returns text language plpgsql as $$
begin
	perform private.store_verify();
	return '';
exception when others then
	return sqlerrm;
end $$;
grant execute on all functions in schema t to anon, authenticated;

select count(*) as items into temp kit_items from public.store_bundle_items;
grant select on kit_items to authenticated;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

insert into t.v select 'inv', t.sync(array['pair-1', 'pair-2', 'lone-rh', 'unset', 'marked', 'marked-held', 'pocket', 'pocket-loose', 'gone', 'nope', 'old-binder', 'pt', 'c040', (select l.id from public.store_listings l where l.kind = 'sealed' and l.status = 'available' limit 1)]);

select t.ok(j -> 'pair-1' ->> 'status' = 'available' and t.reason(j, 'pair-1') is null, 'invariant: the first of two loose copies is listed') from t.v where k = 'inv';
select t.ok(t.reason(j, 'pair-2') = 'last' and not j ? 'pair-2', 'invariant: a batch of two loose copies keeps the second home') from t.v where k = 'inv';
select t.ok(t.reason(j, 'lone-rh') = 'last', 'invariant: a lone reverse holo is the last of its finish') from t.v where k = 'inv';
select t.ok(t.reason(j, 'unset') = 'last', 'invariant: an unset finish never pairs with Normal') from t.v where k = 'inv';
select t.ok(j -> 'marked' ->> 'status' = 'available', 'invariant: a last copy marked For sale is listed') from t.v where k = 'inv';
select t.ok(j -> 'marked-held' ->> 'status' = 'available', 'invariant: a copy in a pocket marked For sale is listed') from t.v where k = 'inv';
select t.ok(t.reason(j, 'pocket') = 'held', 'invariant: a copy in a hand binder pocket is held') from t.v where k = 'inv';
select t.ok(j -> 'pocket-loose' ->> 'status' = 'available', 'invariant: its loose twin is listed (the pocket copy stays home)') from t.v where k = 'inv';
select t.ok(t.reason(j, 'gone') = 'missing', 'invariant: a deleted copy is missing') from t.v where k = 'inv';
select t.ok(t.reason(j, 'nope') = 'missing', 'invariant: an unknown copy is missing') from t.v where k = 'inv';
select t.ok(j -> 'old-binder' ->> 'status' = 'available', 'invariant: a deleted binder holds nothing') from t.v where k = 'inv';
select t.ok(t.reason(j, 'pt') = 'last', 'invariant: another language is another key') from t.v where k = 'inv';
select t.ok(j -> 'c040' ->> 'status' = 'reserved' and t.reason(j, 'c040') is null, 'invariant: a reserved row passes through untouched') from t.v where k = 'inv';
select t.ok(jsonb_array_length(j -> '_skipped') = 7, 'invariant: seven rows skipped, nothing else') from t.v where k = 'inv';
select t.ok((select count(*) from public.store_listings where id in ('pair-2', 'lone-rh', 'unset', 'pocket', 'gone', 'nope', 'pt')) = 0, 'invariant: no skipped row reached the catalog');
select t.ok((select count(*) from public.store_listings where kind = 'sealed' and status = 'available') > 0, 'invariant: sealed units untouched');
select t.ok((select count(*) from public.store_bundle_items) = (select items from kit_items), 'invariant: kit items untouched');

-- A copy listed earlier that breaks the rule now is withdrawn (fail closed),
-- and a clean call keeps the answer's old shape.
select t.ok(t.reason(t.sync(array['pair-2', 'pair-1']), 'pair-1') = 'last', 'invariant: order decides which copy stays home');
select t.ok((select status from public.store_listings where id = 'pair-1') = 'withdrawn', 'invariant: a skipped copy listed before is withdrawn');
select t.ok(not (t.sync(array['pair-1']) ? '_skipped'), 'invariant: no _skipped key when nothing is skipped');

-- No document at all: every single is skipped.
reset role;
delete from t.v where k = 'doc';
insert into t.v select 'doc', to_jsonb(d) from public.documents d;
delete from public.documents;
set role authenticated;
select t.ok(t.reason(t.sync(array['pair-1']), 'pair-1') = 'missing', 'invariant: without a document every copy is missing');
reset role;
insert into public.documents (user_id, doc) select (j ->> 'user_id')::uuid, j -> 'doc' from t.v where k = 'doc';
reset request.jwt.claim.sub;

-- =================================================================== M6

-- An older script refuses to run over the hardening, and nothing changes.
\set ON_ERROR_STOP off
\o /tmp/hardening-refused.txt
begin;
\ir ../supabase/store-orders.sql
rollback;
\o /dev/null
\set ON_ERROR_STOP on
select t.ok(to_regprocedure('public.place_order(text[],text,text,text,uuid[])') is not null and private.store_verify() = 'store ok', 'M6: store-orders.sql refused, the hardening stands');

-- On purpose, it runs, and store_verify says loudly what it undid.
set store.allow_rerun = on;
\ir ../supabase/store-orders.sql
\ir ../supabase/store-sealed.sql
reset store.allow_rerun;
select t.err($$select private.store_verify()$$, 'P0001', 'M6: store_verify fails after an older script ran');

-- The documented recovery: the later scripts, then the hardening.
set store.allow_rerun = on;
\ir ../supabase/store-bundles.sql
reset store.allow_rerun;
\ir ../supabase/store-consignment.sql
\ir ../supabase/store-hardening.sql
select t.ok(private.store_verify() = 'store ok', 'M6: the recovery brings everything back');

-- store.sql run again puts back the store_sync that skips nothing.
set store.allow_rerun = on;
\ir ../supabase/store.sql
reset store.allow_rerun;
select t.ok(position('store_sync' in t.verify_error()) > 0, 'M6: store_verify names store_sync after store.sql ran');
set store.allow_rerun = on;
\ir ../supabase/store-bundles.sql
reset store.allow_rerun;
\ir ../supabase/store-consignment.sql
\ir ../supabase/store-hardening.sql
select t.ok(private.store_verify() = 'store ok', 'M6: the hardening brings store_sync back');

\o
select 'store-hardening: all checks passed';
