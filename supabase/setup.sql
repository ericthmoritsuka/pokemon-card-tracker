-- Card Tracker: Supabase setup.
--
-- What it does: creates the four tables the app syncs to (profiles, groups,
-- group_members, documents), turns on row-level security for each, and adds
-- the functions the app calls (claim_owner, add_member, remove_member,
-- group_overview). DESIGN.md sections 3, 4, and 8 explain the model.
--
-- Where to run it: Supabase dashboard, SQL Editor, New query. Paste this
-- whole file and click Run. Running it again is safe: tables are created
-- only when missing, and policies, functions, and the trigger are replaced.
--
-- Run it before the owner's first sign-in. The first person to sign in after
-- it runs becomes the owner of the family group, so the owner signs in right
-- away and then turns off new sign-ups (README.md, Setup).
--
-- Who can do what:
--   - Everyone writes only their own profiles and documents rows.
--   - Everyone reads their own rows and the rows of anyone who shares a group
--     with them. Someone in no group reads only their own rows.
--   - Group and membership rows are read by members of that group and change
--     only through the functions below. Only the owner adds or removes.

-- ------------------------------------------------------------------ tables

create table if not exists public.profiles (
	user_id uuid primary key references auth.users (id) on delete cascade,
	display_name text check (display_name is null or char_length(display_name) <= 60),
	created_at timestamptz not null default now()
);

create table if not exists public.groups (
	id uuid primary key default gen_random_uuid(),
	name text not null check (char_length(name) between 1 and 60),
	owner_id uuid not null references auth.users (id) on delete cascade
);

create table if not exists public.group_members (
	group_id uuid not null references public.groups (id) on delete cascade,
	user_id uuid not null references auth.users (id) on delete cascade,
	role text not null check (role in ('owner', 'member')),
	primary key (group_id, user_id)
);

create index if not exists group_members_user_id on public.group_members (user_id);

-- One row per person: their whole card document (DESIGN.md section 4).
create table if not exists public.documents (
	user_id uuid primary key references auth.users (id) on delete cascade,
	doc jsonb not null check (jsonb_typeof(doc) = 'object'),
	updated_at timestamptz not null default now()
);

-- updated_at is always the server's clock, never the phone's. The app saves
-- with "update only where updated_at still equals what I read", so every
-- write must change it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.updated_at := clock_timestamp();

	return new;
end;
$$;

drop trigger if exists documents_touch_updated_at on public.documents;

create trigger documents_touch_updated_at
	before insert or update on public.documents
	for each row execute function public.touch_updated_at();

-- ------------------------------------------------------- policy helpers

-- Security definer, so the policies below can look at group_members without
-- running group_members' own policy again. They live in a schema the Data API
-- does not expose, so nobody can call them as an API function.

create schema if not exists private;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.shares_group(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.group_members mine
		join public.group_members theirs on theirs.group_id = mine.group_id
		where mine.user_id = (select auth.uid())
			and theirs.user_id = other
	);
$$;

create or replace function private.is_group_member(group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.group_members gm
		where gm.group_id = is_group_member.group_id
			and gm.user_id = (select auth.uid())
	);
$$;

-- --------------------------------------------------------- row security

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.documents enable row level security;

revoke all on public.profiles, public.groups, public.group_members, public.documents from anon;
revoke all on public.profiles, public.groups, public.group_members, public.documents from authenticated;

grant select, insert, update on public.profiles, public.documents to authenticated;
grant select on public.groups, public.group_members to authenticated;

drop policy if exists "profiles: read own and group" on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles: read own and group" on public.profiles
	for select to authenticated
	using (user_id = (select auth.uid()) or private.shares_group(user_id));

create policy "profiles: insert own" on public.profiles
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy "profiles: update own" on public.profiles
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

drop policy if exists "documents: read own and group" on public.documents;
drop policy if exists "documents: insert own" on public.documents;
drop policy if exists "documents: update own" on public.documents;

create policy "documents: read own and group" on public.documents
	for select to authenticated
	using (user_id = (select auth.uid()) or private.shares_group(user_id));

create policy "documents: insert own" on public.documents
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy "documents: update own" on public.documents
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

-- Groups and memberships: read only. There are no insert, update, or delete
-- policies, so those are refused; the functions below make the changes.

drop policy if exists "groups: read as member" on public.groups;
drop policy if exists "group_members: read as member" on public.group_members;

create policy "groups: read as member" on public.groups
	for select to authenticated
	using (private.is_group_member(id));

create policy "group_members: read as member" on public.group_members
	for select to authenticated
	using (private.is_group_member(group_id));

-- -------------------------------------------------------------- functions

-- The first person to call this becomes the owner of the one family group.
-- After that it changes nothing and returns the caller's place in it:
-- {created, group_id, group_name, role}, with null group fields for someone
-- who is not a member.
create or replace function public.claim_owner(group_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	me uuid := auth.uid();
	g public.groups%rowtype;
	was_created boolean := false;
	my_role text;
begin
	if me is null then
		raise exception 'Sign in first.' using errcode = '28000';
	end if;

	-- Two first sign-ins at once must not make two groups.
	perform pg_advisory_xact_lock(hashtext('card-tracker:claim_owner'));

	select * into g from public.groups limit 1;

	if not found then
		insert into public.groups (name, owner_id)
		values (coalesce(nullif(btrim(group_name), ''), 'Family'), me)
		returning * into g;

		insert into public.group_members (group_id, user_id, role)
		values (g.id, me, 'owner');

		was_created := true;
	end if;

	select gm.role into my_role
	from public.group_members gm
	where gm.group_id = g.id and gm.user_id = me;

	return jsonb_build_object(
		'created', was_created,
		'group_id', case when my_role is null then null else g.id end,
		'group_name', case when my_role is null then null else g.name end,
		'role', my_role
	);
end;
$$;

-- Owner only. Adds an existing account (invited from the dashboard, or
-- already signed in) to the owner's group as a member.
create or replace function public.add_member(email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	me uuid := auth.uid();
	gid uuid;
	target uuid;
begin
	select gm.group_id into gid
	from public.group_members gm
	where gm.user_id = me and gm.role = 'owner'
	limit 1;

	if gid is null then
		raise exception 'Only the family owner can add members.' using errcode = '42501';
	end if;

	select u.id into target
	from auth.users u
	where lower(u.email) = lower(btrim(add_member.email));

	if target is null then
		raise exception 'No account uses % yet. Invite them first in the Supabase dashboard (Authentication, Users, Invite), then add them here.', btrim(add_member.email)
			using errcode = 'P0002';
	end if;

	insert into public.group_members (group_id, user_id, role)
	values (gid, target, 'member')
	on conflict (group_id, user_id) do nothing;

	return jsonb_build_object('group_id', gid, 'user_id', target);
end;
$$;

-- Owner only. The owner cannot remove themselves.
create or replace function public.remove_member(user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	me uuid := auth.uid();
	gid uuid;
begin
	select gm.group_id into gid
	from public.group_members gm
	where gm.user_id = me and gm.role = 'owner'
	limit 1;

	if gid is null then
		raise exception 'Only the family owner can remove members.' using errcode = '42501';
	end if;

	if remove_member.user_id = me then
		raise exception 'The owner cannot remove themselves.' using errcode = '42501';
	end if;

	delete from public.group_members gm
	where gm.group_id = gid
		and gm.user_id = remove_member.user_id
		and gm.role = 'member';

	if not found then
		raise exception 'That person is not a member of your family group.' using errcode = 'P0002';
	end if;

	return jsonb_build_object('group_id', gid, 'user_id', remove_member.user_id);
end;
$$;

-- The caller's group and its members, owner first:
-- {group: {id, name, owner_id} | null, role, members: [{user_id, role,
-- display_name, email}]}.
create or replace function public.group_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	me uuid := auth.uid();
	g public.groups%rowtype;
	my_role text;
begin
	select gr.id, gr.name, gr.owner_id, gm.role
	into g.id, g.name, g.owner_id, my_role
	from public.group_members gm
	join public.groups gr on gr.id = gm.group_id
	where gm.user_id = me
	limit 1;

	if my_role is null then
		return jsonb_build_object('group', null, 'members', '[]'::jsonb, 'role', null);
	end if;

	return jsonb_build_object(
		'group', jsonb_build_object('id', g.id, 'name', g.name, 'owner_id', g.owner_id),
		'role', my_role,
		'members', coalesce((
			select jsonb_agg(
				jsonb_build_object(
					'user_id', gm.user_id,
					'role', gm.role,
					'display_name', p.display_name,
					'email', u.email
				)
				order by (gm.role = 'owner') desc, coalesce(p.display_name, u.email)
			)
			from public.group_members gm
			join auth.users u on u.id = gm.user_id
			left join public.profiles p on p.user_id = gm.user_id
			where gm.group_id = g.id
		), '[]'::jsonb)
	);
end;
$$;

-- Signed-in people only. Supabase grants new functions to anon by default,
-- so that grant is taken back explicitly.
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function private.shares_group(uuid) from public, anon;
revoke all on function private.is_group_member(uuid) from public, anon;
revoke all on function public.claim_owner(text) from public, anon;
revoke all on function public.add_member(text) from public, anon;
revoke all on function public.remove_member(uuid) from public, anon;
revoke all on function public.group_overview() from public, anon;

grant execute on function private.shares_group(uuid) to authenticated;
grant execute on function private.is_group_member(uuid) to authenticated;
grant execute on function public.claim_owner(text) to authenticated;
grant execute on function public.add_member(text) to authenticated;
grant execute on function public.remove_member(uuid) to authenticated;
grant execute on function public.group_overview() to authenticated;
