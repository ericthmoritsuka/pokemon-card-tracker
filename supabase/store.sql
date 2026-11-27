-- Card Tracker: the HOTARU shop's catalog (plans/hotaru-catalog-plan.md,
-- sections 6 and 11, step 2).
--
-- What it does: creates the table of what is for sale (store_listings), the
-- function the Shop screen publishes with (store_sync), the one function a
-- visitor without an account may call to read the catalog (store_catalog),
-- and the public Storage bucket store for the card pictures the catalog
-- shows. Orders, reservations, and Pix come in step 5 and are not here.
--
-- Run it after supabase/setup.sql, which it relies on (the family group and
-- its owner). Where: Supabase dashboard, SQL Editor, New query. Paste this
-- whole file and click Run. Running it again is safe: tables and the bucket
-- are created only when missing, and functions and rules are replaced.
--
-- To check it worked: Table Editor lists store_listings; Database,
-- Functions lists store_sync and store_catalog; Storage lists store,
-- marked Public.
--
-- Who can do what:
--   - Only the owner of the family group (whoever signed in first, by
--     setup.sql's claim_owner) publishes, changes, or reads listings
--     directly, and uploads pictures. No email address is written here.
--   - Everyone, signed in or not, reads the available listings through
--     store_catalog() and the pictures through their public links. Nobody
--     else reads the table: a reserved or sold listing, and later the
--     orders, stay private.

-- ----------------------------------------------------------- prerequisite

-- M6 (store-hardening.sql): this script redefines functions that
-- store-hardening.sql replaces, so once that file has run, this one refuses
-- to run rather than silently undo it. To rerun it on purpose, put
-- `set store.allow_rerun = on;` above it, then run every later store script
-- and store-hardening.sql again (DESIGN.md, Store Hardening).
do $$
begin
	if to_regprocedure('private.store_hardening_version()') is not null and coalesce(current_setting('store.allow_rerun', true), '') <> 'on' then
		raise exception 'store-hardening.sql has run, and this older script would undo it. To rerun it on purpose, put "set store.allow_rerun = on;" above it, then run store-hardening.sql again.';
	end if;
end;
$$;

do $$
begin
	if to_regclass('public.groups') is null then
		raise exception 'Run supabase/setup.sql first: this script uses its family group.';
	end if;
end;
$$;

create schema if not exists private;

-- ------------------------------------------------------------------ helper

-- True for the owner of the family group: the shop's owner.
create or replace function private.is_store_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.groups g
		where g.owner_id = (select auth.uid())
	);
$$;

revoke all on function private.is_store_owner() from public, anon;
grant execute on function private.is_store_owner() to authenticated;

-- ------------------------------------------------------------------- table

-- One row per unit for sale. A single is one spare copy from the tracker,
-- keyed by the copy's own ID; a sealed product (step 4) is one row per unit.
-- The price is the one Eric typed (never a market price), and only the
-- copies that are spares of a priced card are ever available.
create table if not exists public.store_listings (
	id text primary key check (char_length(id) between 1 and 64),
	kind text not null default 'single' check (kind in ('single', 'sealed')),
	card_id text check (card_id is null or char_length(card_id) <= 64),
	catalog text check (catalog is null or char_length(catalog) <= 32),
	language text check (language is null or char_length(language) <= 16),
	finish text check (finish is null or char_length(finish) <= 80),
	condition text check (condition is null or char_length(condition) <= 40),
	name text not null check (char_length(name) between 1 and 160),
	set_name text check (set_name is null or char_length(set_name) <= 160),
	number text check (number is null or char_length(number) <= 32),
	rarity text check (rarity is null or char_length(rarity) <= 80),
	description text check (description is null or char_length(description) <= 2000),
	image_path text check (image_path is null or char_length(image_path) <= 200),
	price_brl numeric(10, 2) not null check (price_brl > 0),
	status text not null default 'available' check (status in ('available', 'reserved', 'sold', 'withdrawn')),
	order_id uuid,
	published_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index if not exists store_listings_status on public.store_listings (status);

alter table public.store_listings enable row level security;

revoke all on public.store_listings from anon;

drop policy if exists "store_listings: owner reads" on public.store_listings;

create policy "store_listings: owner reads" on public.store_listings
	for select to authenticated
	using (private.is_store_owner());

-- Writes go through store_sync only, so the rule that a reserved or sold
-- listing never changes is kept in one place.
revoke insert, update, delete on public.store_listings from authenticated;

-- --------------------------------------------------------------- functions

-- Publishes the singles. listings is the whole set of spare copies that should
-- be for sale now, as a JSON array of objects with the table's columns
-- (id, card_id, catalog, language, finish, condition, name, set_name,
-- number, rarity, image_path, price_brl). Each one is added, or brought up
-- to date and made available again; a picture path left out keeps the one
-- already stored. Every single that is available and not in listings is
-- withdrawn: its price was cleared, or it is no longer a spare. A reserved
-- or sold listing is never touched, so a price change never alters a closed
-- order. Returns {<id>: {status, image_path}} for every single in listings.
create or replace function public.store_sync(listings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	ids text[];
	result jsonb;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can publish.' using errcode = '42501';
	end if;

	if jsonb_typeof(listings) is distinct from 'array' then
		raise exception 'listings must be a JSON array.' using errcode = '22023';
	end if;

	if jsonb_array_length(listings) > 2000 then
		raise exception 'At most 2,000 listings at once.' using errcode = '22023';
	end if;

	select coalesce(array_agg(e.value->>'id'), '{}') into ids from jsonb_array_elements(listings) as e(value);

	insert into public.store_listings as l (id, kind, card_id, catalog, language, finish, condition, name, set_name, number, rarity, image_path, price_brl, status, published_at, updated_at)
	select
		e.value->>'id',
		'single',
		e.value->>'card_id',
		e.value->>'catalog',
		e.value->>'language',
		e.value->>'finish',
		e.value->>'condition',
		e.value->>'name',
		e.value->>'set_name',
		e.value->>'number',
		e.value->>'rarity',
		e.value->>'image_path',
		(e.value->>'price_brl')::numeric(10, 2),
		'available',
		now(),
		now()
	from jsonb_array_elements(listings) as e(value)
	on conflict (id) do update
	set
		card_id = excluded.card_id,
		catalog = excluded.catalog,
		language = excluded.language,
		finish = excluded.finish,
		condition = excluded.condition,
		name = excluded.name,
		set_name = excluded.set_name,
		number = excluded.number,
		rarity = excluded.rarity,
		image_path = coalesce(excluded.image_path, l.image_path),
		price_brl = excluded.price_brl,
		status = 'available',
		published_at = case when l.status = 'withdrawn' then now() else l.published_at end,
		updated_at = now()
	where l.kind = 'single' and l.status in ('available', 'withdrawn');

	update public.store_listings l
	set status = 'withdrawn', updated_at = now()
	where l.kind = 'single' and l.status = 'available' and not (l.id = any (ids));

	select coalesce(jsonb_object_agg(l.id, jsonb_build_object('image_path', l.image_path, 'status', l.status)), '{}')
	into result
	from public.store_listings l
	where l.id = any (ids);

	return result;
end;
$$;

-- What a visitor sees: the available listings only, with the columns the
-- catalog shows. A reserved, sold, or withdrawn listing is simply absent.
-- Dropped first: supabase/store-orders.sql and store-bundles.sql replace it with
-- other columns, and a replace cannot change them.
drop function if exists public.store_catalog();

create function public.store_catalog()
returns table (
	id text,
	kind text,
	card_id text,
	catalog text,
	language text,
	finish text,
	condition text,
	name text,
	set_name text,
	number text,
	rarity text,
	description text,
	image_path text,
	price_brl numeric,
	published_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
	select l.id, l.kind, l.card_id, l.catalog, l.language, l.finish, l.condition, l.name, l.set_name, l.number, l.rarity, l.description, l.image_path, l.price_brl, l.published_at
	from public.store_listings l
	where l.status = 'available'
	order by l.set_name nulls last, l.number, l.name, l.id;
$$;

-- Supabase grants new functions to anon by default, so each grant is
-- spelled out.
revoke all on function public.store_sync(jsonb) from public, anon;
grant execute on function public.store_sync(jsonb) to authenticated;

revoke all on function public.store_catalog() from public;
grant execute on function public.store_catalog() to anon, authenticated;

-- ------------------------------------------------------------------ bucket

-- Public, so the catalog shows pictures by plain links; at most 1 MB per
-- file (a TCGdex picture is about 100 to 300 KB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store', 'store', true, 1048576, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
set
	name = excluded.name,
	public = true,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

-- True for the path shapes the apps write: tcgdex/<TCGdex picture path>.webp
-- or .png for a card, sealed/<id>.webp or .jpg for a sealed product.
create or replace function private.is_store_path(object_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select object_name ~ '^tcgdex/[a-z]{2}(-[a-z]{2})?/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.(webp|png)$'
		or object_name ~ '^sealed/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$';
$$;

revoke all on function private.is_store_path(text) from public, anon;
grant execute on function private.is_store_path(text) to authenticated;

-- An upload that replaces a file needs the read, add, and replace rules
-- together. Reading a public bucket's files by link needs no rule.
drop policy if exists "store: owner reads" on storage.objects;
drop policy if exists "store: owner adds" on storage.objects;
drop policy if exists "store: owner replaces" on storage.objects;
drop policy if exists "store: owner deletes" on storage.objects;

create policy "store: owner reads" on storage.objects
	for select to authenticated
	using (bucket_id = 'store' and private.is_store_owner());

create policy "store: owner adds" on storage.objects
	for insert to authenticated
	with check (bucket_id = 'store' and private.is_store_path(name) and private.is_store_owner());

create policy "store: owner replaces" on storage.objects
	for update to authenticated
	using (bucket_id = 'store' and private.is_store_owner())
	with check (bucket_id = 'store' and private.is_store_path(name) and private.is_store_owner());

create policy "store: owner deletes" on storage.objects
	for delete to authenticated
	using (bucket_id = 'store' and private.is_store_owner());
