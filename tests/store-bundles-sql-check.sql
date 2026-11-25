-- Checks supabase/store-bundles.sql (kits, Eric 2026-11-25) against plain
-- Postgres, after every store script it builds on, with a minimal stand-in
-- for Supabase's auth and storage schemas and roles. Run by
-- tests/store-bundles-sql-check.sh, which also runs the two-connection race.
-- Every check raises an exception on failure, so a clean run means all
-- passed.

\set ON_ERROR_STOP on
\o /dev/null
set client_min_messages = warning;

-- The stand-in: the API roles, auth.users, auth.uid() reading the user ID
-- the way Supabase's does, and the storage tables the store scripts add
-- their buckets and rules to.
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
-- Supabase's defaults: new functions, tables, and sequences are granted to
-- the API roles, so each script's own revokes are what keep them private.
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;

insert into auth.users values
	('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
	('00000000-0000-0000-0000-00000000000b', 'member@example.test');

\ir ../supabase/setup.sql
\ir ../supabase/store.sql
\ir ../supabase/store-orders.sql
\ir ../supabase/store-sealed.sql
\ir ../supabase/store-bundles.sql
-- Running the older scripts again goes back to orders without kits, with one
-- place_order, and running this one again brings kits back.
\ir ../supabase/store.sql
\ir ../supabase/store-orders.sql
\ir ../supabase/store-sealed.sql
\ir ../supabase/store-bundles.sql
\ir ../supabase/store-bundles.sql

do $$
begin
	if (select count(*) from pg_proc where proname = 'place_order') <> 1 then
		raise exception 'FAIL: more than one place_order after the reruns';
	end if;
end;
$$;

-- Assertion helpers (security invoker, so they run as the role under test).
-- t.ok and t.err raise on failure.
create schema t;
grant usage on schema t to anon, authenticated;
create function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin
	if cond is not true then raise exception 'FAIL: %', label; end if;
	raise notice 'ok: %', label;
end $$;
create function t.err(stmt text, code text, label text) returns void language plpgsql as $$
begin
	execute stmt;
	raise exception 'FAIL (no error): %', label;
exception when others then
	if sqlstate = code then raise notice 'ok: % (%)', label, sqlstate;
	elsif sqlerrm like 'FAIL%' then raise;
	else raise exception 'FAIL: % got % %', label, sqlstate, sqlerrm; end if;
end $$;
grant execute on all functions in schema t to anon, authenticated;
create table t.v (k text primary key, j jsonb);
grant all on t.v to anon, authenticated;

-- People: an owner and a member of the family group.
insert into public.groups (id, name, owner_id) values ('10000000-0000-0000-0000-000000000000', 'Fam', '00000000-0000-0000-0000-00000000000a');
insert into public.group_members values ('10000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000a', 'owner'), ('10000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000b', 'member');

-- Listings: three MEP starters at R$ 5,00, a second Sprigatito, 25 fillers, and a sealed unit.
insert into public.store_listings (id, kind, card_id, name, set_name, number, condition, price_brl) values
	('c-spr', 'single', 'mep-001', 'Sprigatito', 'MEP', '001', 'NM', 5.00),
	('c-fue', 'single', 'mep-002', 'Fuecoco', 'MEP', '002', 'NM', 5.00),
	('c-qua', 'single', 'mep-003', 'Quaxly', 'MEP', '003', 'NM', 5.00),
	('c-spr2', 'single', 'mep-001', 'Sprigatito', 'MEP', '001', 'LP', 5.00),
	('c-cheap', 'single', 'x-1', 'Cheap', 'X', '1', 'NM', 0.30),
	('c-dear', 'single', 'x-2', 'Dear', 'X', '2', 'NM', 9.70);
insert into public.store_listings (id, kind, card_id, name, price_brl) select 'f-' || n, 'single', 'f', 'Filler ' || n, 1.00 from generate_series(1, 25) n;
insert into public.store_listings (id, kind, card_id, name, price_brl) values ('s-1', 'sealed', null, 'Booster', 30.00);

-- ---------------------------------------------------------------- owner
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

insert into t.v select 'trio', public.save_bundle('{"name": "Trio inicial MEP", "price_mode": "percent", "discount_pct": 5, "items": ["c-spr", "c-fue", "c-qua"]}');
select t.ok((j ->> 'price')::numeric = 14.25, 'percent 5% of 15,00 is 14,25') from t.v where k = 'trio';
select t.ok((j ->> 'sum')::numeric = 15.00 and (j ->> 'available')::boolean, 'sum 15 and available') from t.v where k = 'trio';
select t.ok(j -> 'items' -> 0 ->> 'listing_id' = 'c-spr' and j -> 'items' -> 2 ->> 'listing_id' = 'c-qua', 'items keep their order') from t.v where k = 'trio';

insert into t.v select 'odd', public.save_bundle('{"name": "Odd", "price_mode": "percent", "discount_pct": 7.5, "items": ["c-cheap", "c-dear"]}');
select t.ok((j ->> 'price')::numeric = 9.25, '7.5% of 10,00 is 9,25') from t.v where k = 'odd';

insert into t.v select 'fixed', public.save_bundle('{"name": "Fixed", "price_mode": "fixed", "price_brl": 3, "items": ["f-1", "f-2", "f-3", "f-4"]}');
select t.ok((j ->> 'price')::numeric = 3.00, 'fixed price is the typed one') from t.v where k = 'fixed';

select t.err($$select public.save_bundle('{"name": "One", "price_mode": "fixed", "price_brl": 3, "items": ["f-5"]}')$$, '22023', 'one card is not a kit');
select t.err($$select public.save_bundle('{"name": "Dup", "price_mode": "fixed", "price_brl": 3, "items": ["f-5", "f-5"]}')$$, '22023', 'the same card twice');
select t.err($$select public.save_bundle('{"name": "Sealed", "price_mode": "fixed", "price_brl": 3, "items": ["f-5", "s-1"]}')$$, '22023', 'a sealed unit is not a kit card');
select t.err($$select public.save_bundle('{"name": "Ghost", "price_mode": "fixed", "price_brl": 3, "items": ["f-5", "nope"]}')$$, '22023', 'an unknown listing');
select t.err($$select public.save_bundle('{"name": "Pct", "price_mode": "percent", "discount_pct": 95, "items": ["f-5", "f-6"]}')$$, '22023', 'discount above 90%');
select t.err($$select public.save_bundle('{"name": "", "price_mode": "fixed", "price_brl": 3, "items": ["f-5", "f-6"]}')$$, '22023', 'empty name');
select t.err($$select public.save_bundle('{"name": "Mode", "price_mode": "free", "items": ["f-5", "f-6"]}')$$, '22023', 'unknown price mode');

-- Editing replaces the cards (the Shop's refill) and keeps the ID.
insert into t.v select 'refill', public.save_bundle(jsonb_build_object('id', (select j ->> 'id' from t.v where k = 'fixed'), 'name', 'Fixed', 'price_mode', 'fixed', 'price_brl', 3, 'items', '["f-1", "f-2", "f-6"]'::jsonb));
select t.ok(jsonb_array_length(j -> 'items') = 3 and j ->> 'id' = (select j ->> 'id' from t.v where k = 'fixed'), 'save with id replaces the cards') from t.v where k = 'refill';
select t.ok(jsonb_array_length(public.store_bundles_admin()) = 3, 'owner lists 3 kits');
select t.ok((select count(*) from public.store_bundles) = 3, 'owner reads the table');

-- ---------------------------------------------------------------- member
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select t.err($$select public.save_bundle('{"name": "M", "price_mode": "fixed", "price_brl": 3, "items": ["f-5", "f-6"]}')$$, '42501', 'member cannot save');
select t.err($$select public.delete_bundle(gen_random_uuid())$$, '42501', 'member cannot delete');
select t.err($$select public.store_bundles_admin()$$, '42501', 'member cannot list admin');
select t.ok((select count(*) from public.store_bundles) = 0, 'member reads no kit rows');
select t.err($$insert into public.store_bundles (name, price_mode, price_brl) values ('x', 'fixed', 1)$$, '42501', 'member cannot insert');

-- ------------------------------------------------------------------ anon
reset request.jwt.claim.sub;
set role anon;
select t.err($$select public.save_bundle('{"name": "A", "price_mode": "fixed", "price_brl": 3, "items": ["f-5", "f-6"]}')$$, '42501', 'anon cannot save');
select t.err($$select public.store_bundles_admin()$$, '42501', 'anon cannot list admin');
select t.err($$select count(*) from public.store_bundles$$, '42501', 'anon cannot read kit table');
select t.err($$select private.bundle_row(gen_random_uuid())$$, '42501', 'anon cannot call bundle_row');
select t.ok(jsonb_array_length(public.store_bundles()) = 3, 'anon sees 3 kits');
select t.ok(not (public.store_bundles() -> 0 -> 'items' -> 0 ? 'status'), 'public kit items carry no status');
select t.ok((select bool_and(in_kit) from public.store_catalog() where id in ('c-spr', 'c-fue', 'c-qua')) and not (select in_kit from public.store_catalog() where id = 'c-spr2'), 'in_kit marks kit copies only');
select t.ok((select (k ->> 'discount_pct')::numeric from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Trio inicial MEP') = 5 and (select k -> 'discount_pct' from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Fixed') = 'null', 'discount_pct only on percent kits');

-- Orders.
select t.err($$select public.place_order(array['c-spr'], 'Ana', '81', null, array[(select (k ->> 'id')::uuid from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Trio inicial MEP')])$$, '22023', 'a single also in an ordered kit');
select t.err($$select public.place_order(array(select 'f-' || n from generate_series(7, 25) n), 'Ana', '81', null, array[(select (k ->> 'id')::uuid from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Odd')])$$, '22023', '19 singles plus a 2-card kit is over 20');
select t.ok(public.place_order(array(select 'f-' || n from generate_series(8, 25) n), 'Ana', '81', null, array[(select (k ->> 'id')::uuid from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Odd')]) ? 'code', '18 singles plus a 2-card kit is 20');
-- old 4-argument call (a page that does not know kits)
select t.ok(public.place_order(items => array['f-7'], buyer_name => 'Old', buyer_phone => '81') ? 'code', 'named call without bundles still orders');

reset role;
select t.ok((select total from public.store_orders where name = 'Ana') = 27.25, 'Ana total = 18 + 9,25');
select t.ok((select price_brl from public.store_order_items where listing_id = 'c-cheap') = 0.27 and (select price_brl from public.store_order_items where listing_id = 'c-dear') = 8.98, 'odd split: 0,27 + 8,98 = 9,25');
select t.ok((select bundle_name from public.store_order_items where listing_id = 'c-dear') = 'Odd' and (select bundle_id from public.store_order_items where listing_id = 'f-8') is null, 'kit items carry the kit, singles do not');

set role anon;
-- Trio: take Fuecoco singly, then the kit is gone and an order for it says why.
select t.ok(public.place_order(array['c-fue'], 'Bia', '81') ? 'code', 'Fuecoco sold alone');
select t.ok((select count(*) from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' in ('Trio inicial MEP', 'Odd')) = 0 and (select count(*) from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Fixed') = 1, 'trio broken and odd sold leave; untouched Fixed stays');
select t.ok((public.place_order(null, 'Cid', '81', null, array[(select id from t.v, lateral (select (j ->> 'id')::uuid as id) x where k = 'trio')])) -> 'unavailable_kits' ->> 0 = (select j ->> 'id' from t.v where k = 'trio'), 'ordering the broken kit names it unavailable');
select t.ok(not exists (select 1 from public.store_catalog() where id = 'c-spr') = false, 'Sprigatito still for sale alone');

-- Expiry brings the kit back.
reset role;
update public.store_orders set reserved_until = now() - interval '1 minute' where name = 'Bia';
set role anon;
select t.ok((select count(*) from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Trio inicial MEP') = 1, 'trio back after Bia''s order expired');
reset role;
-- Turned off: gone from the catalog and refused.
update public.store_bundles set active = false where name = 'Trio inicial MEP';
set role anon;
select t.ok((select count(*) from jsonb_array_elements(public.store_bundles()) k where k ->> 'name' = 'Trio inicial MEP') = 0 and not (select in_kit from public.store_catalog() where id = 'c-spr'), 'an off kit is hidden and marks nothing');
select t.ok((public.place_order(null, 'Cid', '81', null, array[(select (j ->> 'id')::uuid from t.v where k = 'trio')])) -> 'unavailable_kits' ->> 0 is not null, 'an off kit is refused');
reset role;
select t.ok((select count(*) from public.store_listings where status = 'reserved' and order_id in (select id from public.store_orders where name = 'Cid')) = 0, 'refused orders reserved nothing');

-- Owner deletes a kit; its cards stay.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t.ok(public.delete_bundle((select (j ->> 'id')::uuid from t.v where k = 'trio')), 'owner deletes the trio');
select t.ok((select count(*) from public.store_listings where id in ('c-spr', 'c-fue', 'c-qua')) = 3, 'its cards stay');
select t.ok(jsonb_array_length(public.store_orders_open()) >= 2, 'owner sees open orders');
select t.ok((select bool_or(i ->> 'bundle_name' = 'Odd') from jsonb_array_elements(public.store_orders_open()) o, jsonb_array_elements(o -> 'items') i), 'open orders name the kit');
