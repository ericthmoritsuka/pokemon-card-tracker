-- Checks supabase/store-withdraw.sql (store_withdraw, Eric 2026-11-24)
-- against plain Postgres, after supabase/setup.sql and supabase/store.sql,
-- with a minimal stand-in for Supabase's auth and storage schemas and roles.
-- Run by tests/store-withdraw-sql-check.sh. Every check raises an exception
-- on failure, so a clean run means all passed.

\set ON_ERROR_STOP on
\o /dev/null
set client_min_messages = warning;

-- The stand-in: the API roles, auth.users, auth.uid() reading the user ID
-- the way Supabase's does, and the storage tables store.sql adds its bucket
-- and rules to.
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
create table storage.objects (bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Supabase's defaults: new functions and tables are granted to the API roles,
-- so each script's own revokes are what keep them private.
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;

insert into auth.users values
	('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
	('00000000-0000-0000-0000-00000000000b', 'member@example.test');

\ir ../supabase/setup.sql
\ir ../supabase/store.sql
-- Run twice: it must be safe to run again.
\ir ../supabase/store-withdraw.sql
\ir ../supabase/store-withdraw.sql

create function pg_temp.act_as(who text) returns void language sql as $$
	select set_config('request.jwt.claim.sub', who, false);
$$;

create function pg_temp.expect_error(statement text, fragment text) returns void language plpgsql as $$
begin
	execute statement;
	raise exception 'Expected an error containing "%" from: %', fragment, statement;
exception when others then
	if position(fragment in sqlerrm) = 0 then
		raise exception 'Wrong error from %: %', statement, sqlerrm;
	end if;
end;
$$;

grant execute on all functions in schema pg_temp to anon, authenticated;

-- The owner claims the group, adds the member, and publishes four copies.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.claim_owner('Family');
select public.add_member('member@example.test');
select public.store_sync('[
	{"id":"fav-1","card_id":"sv03.5-006","catalog":"international","language":"en","name":"Charizard ex","price_brl":300},
	{"id":"fav-2","card_id":"sv03.5-006","catalog":"international","language":"pt","name":"Charizard ex","price_brl":300},
	{"id":"held","card_id":"sv03.5-006","catalog":"international","language":"en","name":"Charizard ex","price_brl":300},
	{"id":"other","card_id":"sv03.5-001","catalog":"international","language":"en","name":"Bulbasaur","price_brl":2}
]'::jsonb);
reset role;

-- An order holds one copy, one was sold earlier, and a sealed unit is listed.
update public.store_listings set status = 'reserved' where id = 'held';
insert into public.store_listings (id, kind, card_id, catalog, name, price_brl, status) values
	('sold', 'single', 'sv03.5-006', 'international', 'Charizard ex', 300, 'sold'),
	('box-1', 'sealed', 'box', 'international', 'A box', 100, 'available');

-- Not the owner: a member and a visitor are refused, and nothing changes.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_error($$select public.store_withdraw(array['fav-1'])$$, 'Only the shop owner');
reset role;
set role anon;
select pg_temp.act_as('');
select pg_temp.expect_error($$select public.store_withdraw(array['fav-1'])$$, 'permission denied');
reset role;

do $$ begin
	if (select status from public.store_listings where id = 'fav-1') <> 'available' then raise exception 'a refused call withdrew a listing'; end if;
end $$;

-- The owner withdraws the starred card's copies: only the available singles
-- go; the reserved and sold copies, an unknown ID, the sealed unit, and
-- another card stay as they were.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');

do $$
declare
	gone text[];
begin
	gone := public.store_withdraw(array['fav-1', 'fav-2', 'held', 'sold', 'box-1', 'nope']);

	if gone <> array['fav-1', 'fav-2'] then raise exception 'withdrew %', gone; end if;

	-- Again: nothing is left to withdraw.
	if cardinality(public.store_withdraw(array['fav-1', 'fav-2'])) <> 0 then raise exception 'withdrew twice'; end if;
	if cardinality(public.store_withdraw(array[]::text[])) <> 0 then raise exception 'an empty list withdrew'; end if;
end $$;

select pg_temp.expect_error($$select public.store_withdraw(null)$$, 'ids must be an array');
select pg_temp.expect_error($$select public.store_withdraw(array(select g::text from generate_series(1, 2001) g))$$, 'At most 2,000');
reset role;

do $$ begin
	if (select string_agg(id || '=' || status, ',' order by id) from public.store_listings)
		<> 'box-1=available,fav-1=withdrawn,fav-2=withdrawn,held=reserved,other=available,sold=sold'
	then
		raise exception 'statuses: %', (select string_agg(id || '=' || status, ',' order by id) from public.store_listings);
	end if;
end $$;

-- A visitor no longer sees the favorite.
set role anon;
do $$ begin
	if exists (select 1 from public.store_catalog() where card_id = 'sv03.5-006') then raise exception 'the favorite is still in the catalog'; end if;
	if not exists (select 1 from public.store_catalog() where id = 'other') then raise exception 'another card left the catalog'; end if;
end $$;
reset role;

-- A star taken off and Publish again brings a withdrawn copy back.
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.store_sync('[{"id":"fav-1","card_id":"sv03.5-006","catalog":"international","language":"en","name":"Charizard ex","price_brl":300},{"id":"other","card_id":"sv03.5-001","catalog":"international","language":"en","name":"Bulbasaur","price_brl":2}]'::jsonb);
reset role;

do $$ begin
	if (select status from public.store_listings where id = 'fav-1') <> 'available' then raise exception 'store_sync did not bring fav-1 back'; end if;
end $$;

\o
select 'store-withdraw.sql: all checks passed' as result;
