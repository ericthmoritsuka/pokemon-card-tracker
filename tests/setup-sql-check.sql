-- Checks supabase/setup.sql against plain Postgres with a minimal stand-in
-- for Supabase's auth schema and roles. Run by tests/setup-sql-check.sh.
-- Every check raises an exception on failure, so a clean run means all
-- passed.

\set ON_ERROR_STOP on
\o /dev/null
set client_min_messages = warning;

-- The stand-in: the two API roles, auth.users, and auth.uid() reading the
-- user ID the way Supabase's does.
create role anon nologin;
create role authenticated nologin;
create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
	$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated;

insert into auth.users values
	('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
	('00000000-0000-0000-0000-00000000000b', 'kid@example.test'),
	('00000000-0000-0000-0000-00000000000c', 'stranger@example.test');

-- Run twice: it must be idempotent.
\ir ../supabase/setup.sql
\ir ../supabase/setup.sql

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

grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- The first caller becomes the owner; a second call changes nothing.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
do $$ begin
	if not (public.claim_owner('Family') ->> 'created')::boolean then raise exception 'owner not created'; end if;
	if (public.claim_owner('Other') ->> 'created')::boolean then raise exception 'second group created'; end if;
	if public.claim_owner('x') ->> 'role' <> 'owner' then raise exception 'owner role missing'; end if;
end $$;

insert into public.profiles (user_id, display_name) values ('00000000-0000-0000-0000-00000000000a', 'Eric');
insert into public.documents (user_id, doc) values ('00000000-0000-0000-0000-00000000000a', '{"cards": []}');

-- Writing someone else's rows is refused.
select pg_temp.expect_error($$insert into public.documents (user_id, doc) values ('00000000-0000-0000-0000-00000000000b', '{}')$$, 'row-level security');
select pg_temp.expect_error($$insert into public.groups (name, owner_id) values ('x', '00000000-0000-0000-0000-00000000000a')$$, 'permission denied');
select pg_temp.expect_error($$insert into public.group_members values ((select id from public.groups), '00000000-0000-0000-0000-00000000000c', 'member')$$, 'permission denied');

-- add_member: unknown email fails clearly; a known one is added.
select pg_temp.expect_error($$select public.add_member('nobody@example.test')$$, 'Invite them first');
select public.add_member('KID@example.test ');

-- The owner cannot remove themselves.
select pg_temp.expect_error($$select public.remove_member('00000000-0000-0000-0000-00000000000a')$$, 'cannot remove themselves');

-- The member: claim_owner is a no-op, add_member is refused, owner's
-- document and profile are readable but not writable.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
do $$ begin
	if (public.claim_owner('Mine') ->> 'created')::boolean then raise exception 'member created a group'; end if;
	if public.claim_owner('Mine') ->> 'role' <> 'member' then raise exception 'member role missing'; end if;
	if (select count(*) from public.documents) <> 1 then raise exception 'member cannot read the owner document'; end if;
	if (select count(*) from public.profiles) <> 1 then raise exception 'member cannot read the owner profile'; end if;
	if jsonb_array_length(public.group_overview() -> 'members') <> 2 then raise exception 'overview members'; end if;
	if public.group_overview() -> 'members' -> 0 ->> 'role' <> 'owner' then raise exception 'owner not first'; end if;
end $$;
select pg_temp.expect_error($$select public.add_member('stranger@example.test')$$, 'Only the family owner');
select pg_temp.expect_error($$select public.remove_member('00000000-0000-0000-0000-00000000000a')$$, 'Only the family owner');
update public.documents set doc = '{"hacked": true}' where user_id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
	if (select doc ? 'hacked' from public.documents where user_id = '00000000-0000-0000-0000-00000000000a') then raise exception 'member changed the owner document'; end if;
end $$;
insert into public.documents (user_id, doc) values ('00000000-0000-0000-0000-00000000000b', '{"cards": []}');

-- Someone in no group sees only their own rows.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000c');
do $$ begin
	if (public.claim_owner('Mine') ->> 'created')::boolean then raise exception 'stranger created a group'; end if;
	if public.claim_owner('Mine') ->> 'group_name' is not null then raise exception 'stranger sees the group'; end if;
	if (select count(*) from public.documents) <> 0 then raise exception 'stranger reads documents'; end if;
	if (select count(*) from public.groups) <> 0 then raise exception 'stranger reads groups'; end if;
	if public.group_overview() -> 'group' <> 'null'::jsonb then raise exception 'stranger overview'; end if;
end $$;

-- The compare-and-set guard: updated_at moves on every write, so an update
-- filtered on the old value matches nothing.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
do $$
declare
	before timestamptz;
	hits int;
begin
	select updated_at into before from public.documents where user_id = auth.uid();
	update public.documents set doc = '{"cards": [1]}' where user_id = auth.uid() and updated_at = before;
	get diagnostics hits = row_count;
	if hits <> 1 then raise exception 'first guarded update missed'; end if;
	update public.documents set doc = '{"cards": [2]}' where user_id = auth.uid() and updated_at = before;
	get diagnostics hits = row_count;
	if hits <> 0 then raise exception 'stale guarded update applied'; end if;
end $$;

-- Owner removes the member; the member then sees only their own rows.
select public.remove_member('00000000-0000-0000-0000-00000000000b');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
do $$ begin
	if (select count(*) from public.documents) <> 1 then raise exception 'removed member still reads the owner'; end if;
end $$;

-- anon can do nothing.
reset role;
set role anon;
select pg_temp.expect_error($$select * from public.documents$$, 'permission denied');
select pg_temp.expect_error($$select public.group_overview()$$, 'permission denied');
select pg_temp.expect_error($$select private.shares_group(null)$$, 'permission denied');
reset role;

\echo 'setup.sql: all checks passed'
