-- Checks supabase/store-consignment.sql (consignment, Eric 2026-11-26)
-- against plain Postgres, after every store script it builds on, with a
-- minimal stand-in for Supabase's auth and storage schemas and roles. Run by
-- tests/store-consignment-sql-check.sh. Every check raises an exception on
-- failure, so a clean run means all passed.

\set ON_ERROR_STOP on
\o /dev/null
set client_min_messages = warning;

-- The stand-in, as in tests/store-bundles-sql-check.sql.
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

insert into auth.users values
	('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
	('00000000-0000-0000-0000-00000000000b', 'member@example.test');

\ir ../supabase/setup.sql
\ir ../supabase/store.sql
\ir ../supabase/store-orders.sql
\ir ../supabase/store-sealed.sql
\ir ../supabase/store-bundles.sql
\ir ../supabase/store-own-pictures.sql
\ir ../supabase/store-withdraw.sql
\ir ../supabase/store-consignment.sql
-- Safe to run again.
\ir ../supabase/store-consignment.sql
\ir ../supabase/store-consignment-delete.sql
\ir ../supabase/store-consignment-delete.sql

-- Assertion helpers, as in tests/store-bundles-sql-check.sql.
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
create function t.id(key text) returns text language sql stable as $$ select j ->> 'id' from t.v where k = key $$;
grant execute on function t.id(text) to anon, authenticated;

-- ------------------------------------------------------- formula and paths

select t.ok(private.commission(100, 15, 5) = 15.00, 'R$ 100 at 15% is R$ 15');
select t.ok(private.commission(20, 15, 5) = 5.00, 'R$ 20 takes the R$ 5 minimum');
select t.ok(private.commission(33.33, 15, 5) = 5.00, 'R$ 33,33 rounds to R$ 5,00');
select t.ok(private.commission(40, 15, 5) = 6.00, 'R$ 40 at 15% is R$ 6');
select t.ok(private.commission(4, 15, 5) = 4.00, 'never more than the price');
select t.ok(private.commission(50, 15, 10) = 10.00, 'R$ 50 with a R$ 10 minimum');
select t.ok(private.commission(10.05, 15, 0) = 1.51, 'centavo rounding half up');

select t.ok(private.is_store_path('consigned/cons-0b5c6f2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg'), 'consigned photo path');
select t.ok(not private.is_store_path('consigned/../own/x.jpg'), 'no other consigned path');
select t.ok(private.is_store_path('own/abc_1.webp'), 'own photo path kept');
select t.ok(private.is_store_path('tcgdex/en/sv/sv03.5/006.webp'), 'TCGdex path kept');
select t.ok(private.is_store_path('sealed/0b5c6f2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f/a.jpg'), 'sealed path kept');

-- People: an owner and a member of the family group.
insert into public.groups (id, name, owner_id) values ('10000000-0000-0000-0000-000000000000', 'Fam', '00000000-0000-0000-0000-00000000000a');
insert into public.group_members values ('10000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000a', 'owner'), ('10000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000b', 'member');

-- ---------------------------------------------------------------- owner
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select t.ok((public.store_consignment_admin() -> 'settings' ->> 'commission_pct')::numeric = 15
	and (public.store_consignment_admin() -> 'settings' ->> 'min_commission_brl')::numeric = 5, 'defaults start at 15% and R$ 5');

insert into t.v select 'ana', public.save_consignor('{"name": "Ana", "phone": "81 90000-0000", "pix_key": "ana@example.test"}');
insert into t.v select 'bia', public.save_consignor('{"name": "Bia", "commission_pct": 10, "min_commission_brl": 3}');
select t.ok(j ->> 'commission_pct' is null, 'Ana uses the defaults') from t.v where k = 'ana';

select t.err($$select public.save_consignor('{"name": ""}')$$, '22023', 'a consignor needs a name');
select t.err($$select public.save_consignor('{"name": "X", "commission_pct": 95}')$$, '22023', 'percent above 90');
select t.err($$select public.save_consignor('{"name": "X", "commission_pct": "ten"}')$$, '22023', 'percent not a number');

insert into t.v select 'c1', public.save_consigned(jsonb_build_object('consignor_id', t.id('ana'), 'card_id', 'base1-4', 'catalog', 'international', 'language', 'en', 'finish', 'Holo', 'condition', 'NM', 'name', 'Charizard', 'set_name', 'Base Set', 'number', '4', 'price_brl', 100));
insert into t.v select 'c2', public.save_consigned(jsonb_build_object('consignor_id', t.id('ana'), 'card_id', 'base1-58', 'name', 'Pikachu', 'price_brl', 20));
insert into t.v select 'c3', public.save_consigned(jsonb_build_object('consignor_id', t.id('bia'), 'card_id', 'base1-2', 'name', 'Blastoise', 'price_brl', 50));
insert into t.v select 'c4', public.save_consigned(jsonb_build_object('consignor_id', t.id('ana'), 'card_id', 'base1-15', 'name', 'Venusaur', 'price_brl', 40, 'commission_pct', 20));

select t.ok(j ->> 'id' like 'cons-%' and j ->> 'status' = 'available', 'a new consigned card is for sale') from t.v where k = 'c1';
select t.ok((j ->> 'commission_pct')::numeric = 15 and (j ->> 'payout_brl')::numeric = 85, 'Ana''s card takes the defaults') from t.v where k = 'c1';
select t.ok((j ->> 'commission_pct')::numeric = 10 and (j ->> 'min_commission_brl')::numeric = 3 and (j ->> 'commission_brl')::numeric = 5, 'Bia''s card takes her terms') from t.v where k = 'c3';
select t.ok((j ->> 'commission_pct')::numeric = 20 and (j ->> 'commission_brl')::numeric = 8, 'terms typed on the card win') from t.v where k = 'c4';
select t.ok((select kind from public.store_listings where id = t.id('c1')) = 'consigned', 'stored as kind consigned');

select t.err($$select public.save_consigned('{"name": "No owner", "price_brl": 10}')$$, '22023', 'a card needs a consignor');
select t.err(format($$select public.save_consigned('{"consignor_id": "%s", "name": "Free", "price_brl": 0}')$$, t.id('ana')), '22023', 'price must be above zero');
select t.err(format($$select public.save_consigned('{"consignor_id": "%s", "price_brl": 5}')$$, t.id('ana')), '22023', 'a card needs a name');
select t.err(format($$select public.save_consigned('{"consignor_id": "%s", "name": "X", "price_brl": 5, "commission_pct": 91}')$$, t.id('ana')), '22023', 'card percent above 90');

-- A later change of defaults leaves deals already made alone.
select public.save_store_settings('{"commission_pct": 20, "min_commission_brl": 5}');
select t.ok((public.store_consignment_admin() -> 'settings' ->> 'commission_pct')::numeric = 20, 'defaults change');
select t.ok((select (c ->> 'commission_pct')::numeric = 15 from jsonb_array_elements(public.store_consignment_admin() -> 'cards') c where c ->> 'id' = t.id('c1')), 'Charizard keeps 15%');
select public.save_store_settings('{"commission_pct": 15, "min_commission_brl": 5}');
select t.err($$select public.save_store_settings('{"commission_pct": 15}')$$, '22023', 'settings need both numbers');

-- The Shop's Publish and the star withdraw touch singles only.
select public.store_sync('[{"id": "mine-1", "card_id": "sv03.5-001", "catalog": "international", "language": "en", "name": "Bulbasaur", "price_brl": 2}]'::jsonb);
select public.store_sync('[]'::jsonb);
select t.ok((select status from public.store_listings where id = 'mine-1') = 'withdrawn', 'Publish withdraws a single left out');
select t.ok((select count(*) from public.store_listings where kind = 'consigned' and status = 'available') = 4, 'Publish leaves consigned cards for sale');
select public.store_withdraw(array[t.id('c1')]);
select t.ok((select status from public.store_listings where id = t.id('c1')) = 'available', 'the star withdraw leaves a consigned card');

-- Kits take singles only.
select public.store_sync('[{"id": "mine-1", "card_id": "sv03.5-001", "catalog": "international", "language": "en", "name": "Bulbasaur", "price_brl": 2}, {"id": "mine-2", "card_id": "sv03.5-004", "catalog": "international", "language": "en", "name": "Charmander", "price_brl": 3}]'::jsonb);
select t.err(format($$select public.save_bundle('{"name": "Mixed", "price_mode": "fixed", "price_brl": 3, "items": ["mine-1", "%s"]}')$$, t.id('c2')), '22023', 'a consigned card is not a kit card');

-- ------------------------------------------------------------------ anon
reset request.jwt.claim.sub;
set role anon;

select t.ok((select count(*) from public.store_catalog() c where c.kind = 'consigned') = 4, 'HOTARU lists the consigned cards');
select t.ok((select c.price_brl from public.store_catalog() c where c.id = t.id('c1')) = 100, 'the buyer sees the price');
insert into t.v select 'order', public.place_order(array[t.id('c1'), t.id('c2'), 'mine-1'], 'Buyer', '81 91111-1111');
select t.ok((j ->> 'total')::numeric = 122, 'the order totals R$ 122') from t.v where k = 'order';

select t.err($$select count(*) from public.store_consignors$$, '42501', 'anon cannot read consignors');
select t.err($$select count(*) from public.store_payouts$$, '42501', 'anon cannot read payouts');
select t.err($$select public.save_consignor('{"name": "A"}')$$, '42501', 'anon cannot add a consignor');
select t.err($$select public.store_consignment_admin()$$, '42501', 'anon cannot list consignment');

-- ---------------------------------------------------------------- member
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';

select t.err(format($$select public.save_consigned('{"consignor_id": "%s", "name": "M", "price_brl": 5}')$$, t.id('ana')), '42501', 'member cannot consign');
select t.err($$select public.store_consignment_admin()$$, '42501', 'member cannot list consignment');
select t.err($$select public.mark_payouts_paid(array[gen_random_uuid()])$$, '42501', 'member cannot mark payouts');
select t.err($$select public.save_store_settings('{"commission_pct": 1, "min_commission_brl": 0}')$$, '42501', 'member cannot change defaults');
select t.ok((select count(*) from public.store_consignors) = 0, 'member reads no consignor rows');
select t.err($$insert into public.store_payouts (listing_id, order_id, consignor_id, sale_brl, commission_brl, payout_brl) values ('x', gen_random_uuid(), gen_random_uuid(), 1, 0, 1)$$, '42501', 'member cannot insert a payout');

-- --------------------------------------------------------- owner: orders
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select t.err(format($$select public.return_consigned('%s')$$, t.id('c1')), '22023', 'no return while an order holds it');
select t.err(format($$select public.save_consigned('{"id": "%s", "consignor_id": "%s", "name": "Charizard", "price_brl": 90}')$$, t.id('c1'), t.id('ana')), '22023', 'no edit while an order holds it');

select public.mark_paid((select j ->> 'code' from t.v where k = 'order'));

select t.ok((select count(*) from public.store_payouts) = 2, 'one payout per consigned card, none for Eric''s own');
select t.ok((select commission_brl = 15 and payout_brl = 85 and sale_brl = 100 from public.store_payouts where listing_id = t.id('c1')), 'Charizard pays out R$ 85');
select t.ok((select commission_brl = 5 and payout_brl = 15 from public.store_payouts where listing_id = t.id('c2')), 'Pikachu pays out R$ 15');
select t.ok((select status from public.store_listings where id = t.id('c1')) = 'sold', 'the card is sold');

insert into t.v select 'admin1', public.store_consignment_admin();
select t.ok((select bool_and(p ->> 'state' = 'waiting') from t.v, jsonb_array_elements(j -> 'payouts') p where k = 'admin1'), 'payouts wait for delivery');
select t.ok((select (c ->> 'waiting_brl')::numeric = 100 and (c ->> 'due_brl')::numeric = 0 and (c ->> 'sold')::int = 2 and (c ->> 'for_sale')::int = 1 from t.v, jsonb_array_elements(j -> 'consignors') c where k = 'admin1' and c ->> 'name' = 'Ana'), 'Ana: R$ 100 waiting, 2 sold, 1 for sale');

select t.err(format($$select public.save_consigned('{"id": "%s", "consignor_id": "%s", "name": "Charizard", "price_brl": 90}')$$, t.id('c1'), t.id('ana')), '22023', 'no edit after the sale');

select public.mark_delivered((select j ->> 'code' from t.v where k = 'order'));
insert into t.v select 'admin2', public.store_consignment_admin();
select t.ok((select bool_and(p ->> 'state' = 'due') from t.v, jsonb_array_elements(j -> 'payouts') p where k = 'admin2'), 'payouts are due after delivery');
select t.ok((select (c ->> 'due_brl')::numeric = 100 from t.v, jsonb_array_elements(j -> 'consignors') c where k = 'admin2' and c ->> 'name' = 'Ana'), 'Ana: R$ 100 due');

select t.ok((public.mark_payouts_paid((select array_agg(id) from public.store_payouts), 'Pix 26/11') ->> 'marked')::int = 2, 'two payouts marked paid');
select t.ok((public.mark_payouts_paid((select array_agg(id) from public.store_payouts)) ->> 'marked')::int = 0, 'paying again marks none');
select t.ok((select bool_and(paid_note = 'Pix 26/11') from public.store_payouts), 'the first note is kept');
insert into t.v select 'admin3', public.store_consignment_admin();
select t.ok((select (c ->> 'paid_brl')::numeric = 100 and (c ->> 'due_brl')::numeric = 0 from t.v, jsonb_array_elements(j -> 'consignors') c where k = 'admin3' and c ->> 'name' = 'Ana'), 'Ana: R$ 100 paid');

-- ------------------------------------------------- owner: return, relist
select t.ok(public.return_consigned(t.id('c3')) ->> 'status' = 'returned', 'Blastoise goes back to Bia');
select t.ok(not exists (select 1 from public.store_catalog() c where c.id = t.id('c3')), 'a returned card leaves HOTARU');
select t.err(format($$select public.relist_consigned('%s')$$, t.id('c4')), '22023', 'relist only a returned card');
select t.ok(public.relist_consigned(t.id('c3')) ->> 'status' = 'available', 'Blastoise is back on sale');
insert into t.v select 'c3b', public.save_consigned(jsonb_build_object('id', t.id('c3'), 'consignor_id', t.id('bia'), 'name', 'Blastoise', 'price_brl', 60, 'commission_pct', 10, 'min_commission_brl', 3));
select t.ok((j ->> 'price_brl')::numeric = 60 and (j ->> 'commission_brl')::numeric = 6 and j ->> 'id' = t.id('c3'), 'edit keeps the ID and changes the price') from t.v where k = 'c3b';
select t.ok((select image_path is null from public.store_listings where id = t.id('c3')), 'no picture until one is given');

-- ------------------------------------------------- owner: delete for good
-- (supabase/store-consignment-delete.sql)
select t.err(format($$select public.delete_consigned('%s')$$, t.id('c1')), '22023', 'a sold card cannot be deleted');
select t.err($$select public.delete_consigned('cons-missing')$$, 'P0002', 'deleting a card that is not there');
select t.err($$select public.delete_consigned('mine-1')$$, 'P0002', 'delete_consigned never touches Eric''s own singles');
select t.err(format($$select public.delete_consignor('%s')$$, t.id('ana')), '22023', 'a consignor with cards cannot be deleted');

-- A card that was in an order, even one that lapsed, stays in the records.
insert into t.v select 'c5', public.save_consigned(jsonb_build_object('consignor_id', t.id('bia'), 'card_id', 'base1-10', 'name', 'Mewtwo', 'price_brl', 30, 'image_path', 'consigned/cons-0b5c6f2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg'));
reset role;
insert into public.store_orders (id, code, name, phone, total, status, reserved_until, ended_at)
values ('20000000-0000-0000-0000-000000000000', 'HTR-9001', 'Lapsed', '81 92222-2222', 30, 'expired', now() - interval '1 hour', now());
insert into public.store_order_items (order_id, listing_id, price_brl) values ('20000000-0000-0000-0000-000000000000', t.id('c5'), 30);
set role authenticated;
select t.err(format($$select public.delete_consigned('%s')$$, t.id('c5')), '22023', 'a card once in an order stays');
reset role;
delete from public.store_orders where id = '20000000-0000-0000-0000-000000000000';
set role authenticated;

-- Never ordered: Mewtwo goes, with its own picture's path handed back.
insert into t.v select 'del5', public.delete_consigned(t.id('c5'));
select t.ok(j ->> 'image_path' like 'consigned/cons-%' and j ->> 'id' = t.id('c5'), 'delete hands back the picture path') from t.v where k = 'del5';
select t.ok(not exists (select 1 from public.store_listings where id = t.id('c5')) and not exists (select 1 from public.store_consignments where listing_id = t.id('c5')), 'the card and its terms are gone');

-- A returned card that was never ordered can go too, and then its
-- consignor, who has nothing left.
select public.return_consigned(t.id('c3'));
select t.ok(public.delete_consigned(t.id('c3')) ->> 'id' = t.id('c3'), 'a returned card can be deleted');
select t.ok(not exists (select 1 from public.store_catalog() c where c.id = t.id('c3')), 'a deleted card is off HOTARU');
select t.ok(public.delete_consignor(t.id('bia')::uuid) ->> 'id' = t.id('bia'), 'Bia, with no cards, is deleted');
select t.ok(not exists (select 1 from public.store_consignors where id = t.id('bia')::uuid), 'Bia is gone');
select t.err(format($$select public.delete_consignor('%s')$$, t.id('bia')), 'P0002', 'deleting a consignor twice');

-- Members and visitors cannot delete.
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select t.err(format($$select public.delete_consigned('%s')$$, t.id('c4')), '42501', 'member cannot delete a card');
select t.err(format($$select public.delete_consignor('%s')$$, t.id('ana')), '42501', 'member cannot delete a consignor');
reset request.jwt.claim.sub;
set role anon;
select t.err(format($$select public.delete_consigned('%s')$$, t.id('c4')), '42501', 'anon cannot delete a card');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

-- Running the script again keeps every row.
reset role;
\ir ../supabase/store-consignment.sql
select t.ok((select count(*) from public.store_payouts) = 2 and (select count(*) from public.store_consignors) = 1 and (select count(*) from public.store_consignments) = 3, 'a rerun keeps the data');
select t.ok((select commission_pct from public.store_settings) = 15, 'a rerun keeps the defaults');

\o
select 'store-consignment checks: all passed';
