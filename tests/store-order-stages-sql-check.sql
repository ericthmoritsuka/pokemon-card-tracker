-- Checks supabase/store-order-stages.sql (the order checklist's ticks on
-- the server and the delivered list, v122) against plain Postgres, after
-- every store script it builds on, with the same minimal stand-in for
-- Supabase's auth and storage schemas and roles as
-- tests/store-bundles-sql-check.sql. Run by
-- tests/store-order-stages-sql-check.sh. Every check raises an exception on
-- failure, so a clean run means all passed.

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

insert into auth.users values
	('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
	('00000000-0000-0000-0000-00000000000b', 'member@example.test');

-- Before store-bundles.sql, the script refuses to run and says why. The
-- SQL Editor runs a pasted script as one transaction, so its first error
-- undoes the whole run; the transaction here stands in for that.
\ir ../supabase/setup.sql
\ir ../supabase/store.sql
\ir ../supabase/store-orders.sql

\set ON_ERROR_STOP off
\o /tmp/order-stages-early.txt
begin;
\ir ../supabase/store-order-stages.sql
rollback;
\o /dev/null
\set ON_ERROR_STOP on

do $$
begin
	if exists (select 1 from pg_proc where proname = 'store_order_checks') then
		raise exception 'FAIL: store-order-stages.sql ran before store-bundles.sql';
	end if;
end;
$$;

\ir ../supabase/store-sealed.sql
\ir ../supabase/store-bundles.sql
\ir ../supabase/store-order-stages.sql
\ir ../supabase/store-order-stages.sql

-- Assertion helpers (security invoker, so they run as the role under test).
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

insert into public.groups (id, name, owner_id) values ('10000000-0000-0000-0000-000000000000', 'Fam', '00000000-0000-0000-0000-00000000000a');
insert into public.group_members values ('10000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000a', 'owner'), ('10000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000000b', 'member');

insert into public.store_listings (id, kind, card_id, name, set_name, number, condition, price_brl, status) values
	('c-1', 'single', 'x-1', 'One', 'X', '1', 'NM', 5.00, 'reserved'),
	('c-2', 'single', 'x-2', 'Two', 'X', '2', 'NM', 5.00, 'sold'),
	('c-3', 'single', 'x-3', 'Three', 'X', '3', 'NM', 5.00, 'sold'),
	('c-4', 'single', 'x-4', 'Four', 'X', '4', 'NM', 5.00, 'sold'),
	('c-5', 'single', 'x-5', 'Five', 'X', '5', 'NM', 5.00, 'sold'),
	('c-6', 'single', 'x-6', 'Six', 'X', '6', 'NM', 5.00, 'available');

-- Orders: HTR-0001 pending; HTR-0002 paid with two cards; HTR-0003
-- delivered yesterday; HTR-0004 delivered 40 days ago; HTR-0005 cancelled.
insert into public.store_orders (id, code, name, phone, total, status, created_at, reserved_until, paid_at, delivered_at, ended_at) values
	('20000000-0000-0000-0000-000000000001', 'HTR-0001', 'Ana', '81', 5, 'pending', now() - interval '1 hour', now() + interval '47 hours', null, null, null),
	('20000000-0000-0000-0000-000000000002', 'HTR-0002', 'Bia', '81', 10, 'paid', now() - interval '3 hours', now() + interval '45 hours', now() - interval '2 hours', null, now() - interval '2 hours'),
	('20000000-0000-0000-0000-000000000003', 'HTR-0003', 'Caio', '81', 5, 'paid', now() - interval '3 days', now(), now() - interval '3 days', now() - interval '1 day', now() - interval '3 days'),
	('20000000-0000-0000-0000-000000000004', 'HTR-0004', 'Duda', '81', 5, 'paid', now() - interval '45 days', now(), now() - interval '45 days', now() - interval '40 days', now() - interval '45 days'),
	('20000000-0000-0000-0000-000000000005', 'HTR-0005', 'Eva', '81', 5, 'cancelled', now() - interval '5 hours', now(), null, null, now() - interval '4 hours');
insert into public.store_order_items (order_id, listing_id, price_brl) values
	('20000000-0000-0000-0000-000000000001', 'c-1', 5),
	('20000000-0000-0000-0000-000000000002', 'c-2', 5),
	('20000000-0000-0000-0000-000000000002', 'c-3', 5),
	('20000000-0000-0000-0000-000000000003', 'c-4', 5),
	('20000000-0000-0000-0000-000000000004', 'c-5', 5),
	('20000000-0000-0000-0000-000000000005', 'c-6', 5);

-- ---------------------------------------------------------------- owner
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select t.ok(public.store_order_checks() = '{}'::jsonb, 'nothing ticked at first');

select t.ok(public.set_order_check('HTR-0002', 'c-3', true) = '{"checked": true, "code": "HTR-0002", "listing_id": "c-3"}'::jsonb, 'ticks a card of a paid order');
select t.ok(public.set_order_check('HTR-0001', 'c-1', true) ->> 'checked' = 'true', 'ticks a card of a pending order');
select t.ok(public.store_order_checks() = '{"HTR-0001": ["c-1"], "HTR-0002": ["c-3"]}'::jsonb, 'the ticks by order');

-- Ticking again keeps the first time; unticking clears it.
reset role;
create temp table first_tick as select checked_at from public.store_order_items where listing_id = 'c-3';
grant select on first_tick to authenticated;
set role authenticated;
select pg_sleep(0.01);
select public.set_order_check('HTR-0002', 'c-3', true);
select t.ok((select checked_at from first_tick) = (select checked_at from public.store_order_items where listing_id = 'c-3'), 'a second tick keeps the first time');
select t.ok(public.set_order_check('HTR-0002', 'c-3', false) ->> 'checked' = 'false', 'unticks');
select t.ok(public.store_order_checks() = '{"HTR-0001": ["c-1"]}'::jsonb, 'an order with nothing ticked is left out');
select public.set_order_check('HTR-0002', 'c-2', true);
select public.set_order_check('HTR-0002', 'c-3', true);
select t.ok(public.store_order_checks() -> 'HTR-0002' = '["c-2", "c-3"]'::jsonb, 'both cards of HTR-0002 ticked');

select t.err($$select public.set_order_check('HTR-0002', 'c-1', true)$$, 'P0002', 'a card from another order');
select t.err($$select public.set_order_check('HTR-9999', 'c-1', true)$$, 'P0002', 'an unknown order');
select t.err($$select public.set_order_check('HTR-0003', 'c-4', true)$$, '22023', 'a delivered order');
select t.err($$select public.set_order_check('HTR-0005', 'c-6', true)$$, '22023', 'a cancelled order');

-- Delivered drops the order from the ticks, and the delivered list has it.
select public.mark_delivered('HTR-0002');
select t.ok(public.store_order_checks() = '{"HTR-0001": ["c-1"]}'::jsonb, 'a delivered order leaves the ticks');
select t.ok(jsonb_array_length(public.store_orders_delivered()) = 2, 'two delivered in the last 30 days');
select t.ok((public.store_orders_delivered() -> 0 ->> 'code') = 'HTR-0002' and (public.store_orders_delivered() -> 1 ->> 'code') = 'HTR-0003', 'newest delivered first');
select t.ok((public.store_orders_delivered() -> 0 -> 'items' -> 0 ->> 'listing_id') = 'c-2' and (public.store_orders_delivered() -> 0 ->> 'delivered_at') is not null, 'with cards and the delivery time');
select t.ok(jsonb_array_length(public.store_orders_delivered(60)) = 3, 'sixty days reach HTR-0004');
select t.ok(public.store_orders_delivered(1) -> 0 ->> 'code' = 'HTR-0002' and jsonb_array_length(public.store_orders_delivered(1)) = 1, 'one day reaches only today''s');
select t.err($$select public.store_orders_delivered(0)$$, '22023', 'zero days');
select t.err($$select public.store_orders_delivered(400)$$, '22023', 'more than 366 days');

-- Running an older script again keeps the ticks and the calls working.
reset role;
\ir ../supabase/store-bundles.sql
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t.ok(public.store_order_checks() = '{"HTR-0001": ["c-1"]}'::jsonb, 'ticks survive store-bundles.sql run again');
select t.ok(jsonb_array_length(public.store_orders_open()) = 1, 'store_orders_open still answers');

-- --------------------------------------------------------------- member
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select t.err($$select public.store_order_checks()$$, '42501', 'a member reads no ticks');
select t.err($$select public.set_order_check('HTR-0001', 'c-1', false)$$, '42501', 'a member ticks nothing');
select t.err($$select public.store_orders_delivered()$$, '42501', 'a member reads no delivered orders');
select t.err($$update public.store_order_items set checked_at = null$$, '42501', 'a member cannot write the column');

-- -------------------------------------------------------------- visitor
reset role;
set role anon;
set request.jwt.claim.sub = '';
select t.err($$select public.store_order_checks()$$, '42501', 'a visitor calls no tick function');
select t.err($$select public.set_order_check('HTR-0001', 'c-1', false)$$, '42501', 'a visitor ticks nothing');
select t.err($$select public.store_orders_delivered()$$, '42501', 'a visitor reads no delivered orders');
