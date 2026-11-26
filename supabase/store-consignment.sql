-- Card Tracker: consignment for the HOTARU shop
-- (plans/hotaru-consignment-plan.md).
--
-- What it does: lets the shop sell cards that belong to other people for a
-- commission (Eric, 2026-11-26). A consigned card is a store_listings row
-- of kind 'consigned': HOTARU sells it like any single, but it is never a
-- copy in the owner's collection, so the Shop's Publish (store_sync) and
-- the star withdraw (store_withdraw), which touch singles only, leave it
-- alone. It adds the consignors, each consigned card's terms, the shop's
-- default terms, and one payout per consigned card sold, created when the
-- owner marks the order paid.
--
-- Run it after supabase/store.sql, store-orders.sql, store-sealed.sql,
-- store-bundles.sql, and store-own-pictures.sql. Where: Supabase dashboard,
-- SQL Editor, New query. Paste this whole file and click Run. Running it
-- again is safe.
--
-- To check it worked: Table Editor lists store_settings, store_consignors,
-- store_consignments, and store_payouts; Database, Functions lists
-- save_consigned, store_consignment_admin, and mark_payouts_paid.
--
-- This script replaces two functions an earlier script also defines:
-- mark_paid (store-orders.sql) and private.is_store_path
-- (store-own-pictures.sql). Whichever script ran last wins, so after running
-- one of those again, run this one again too.
--
-- The rules (Eric, 2026-11-26):
--   - The commission comes out of the sale price: the buyer pays the price,
--     the consignor gets the price minus the commission.
--   - commission = the percent of the price, rounded to the centavo, but
--     never less than the minimum and never more than the price. The
--     shop's defaults start at 15% and R$ 5,00; a consignor may have their
--     own, and each card keeps the terms it was consigned with, so a later
--     change of defaults never changes a deal already made.
--   - The buyer sees nothing different: a consigned card is listed like
--     any single.
--   - A payout is due once its order is delivered; it is created when the
--     order is marked paid, and the owner marks it paid after the Pix to
--     the consignor.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_bundles') is null then
		raise exception 'Run supabase/store-bundles.sql first: this script builds on the orders it last defined.';
	end if;
end;
$$;

-- -------------------------------------------------------------- the kind

-- store.sql allows 'single' and 'sealed'. Every check on store_listings
-- that names kind is dropped by its definition rather than by name, so the
-- name Postgres gave it does not matter, and the wider one is added.
do $$
declare
	c record;
begin
	for c in
		select con.conname
		from pg_constraint con
		where con.conrelid = 'public.store_listings'::regclass
			and con.contype = 'c'
			and pg_get_constraintdef(con.oid) like '%kind%'
	loop
		execute format('alter table public.store_listings drop constraint %I', c.conname);
	end loop;
end;
$$;

alter table public.store_listings
	add constraint store_listings_kind_check check (kind in ('single', 'sealed', 'consigned'));

-- ------------------------------------------------------------------ tables

-- The shop's default terms: one row.
create table if not exists public.store_settings (
	id boolean primary key default true check (id),
	commission_pct numeric(5, 2) not null default 15 check (commission_pct between 0 and 90),
	min_commission_brl numeric(10, 2) not null default 5 check (min_commission_brl between 0 and 1000),
	updated_at timestamptz not null default now()
);

insert into public.store_settings (id) values (true) on conflict (id) do nothing;

-- Whoever leaves cards with the shop. Null terms mean the shop's defaults.
create table if not exists public.store_consignors (
	id uuid primary key default gen_random_uuid(),
	name text not null check (char_length(name) between 1 and 80),
	phone text check (phone is null or char_length(phone) <= 40),
	pix_key text check (pix_key is null or char_length(pix_key) <= 140),
	commission_pct numeric(5, 2) check (commission_pct is null or commission_pct between 0 and 90),
	min_commission_brl numeric(10, 2) check (min_commission_brl is null or min_commission_brl between 0 and 1000),
	note text check (note is null or char_length(note) <= 500),
	active boolean not null default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

-- One row per consigned listing: whose it is and the terms it was taken on.
create table if not exists public.store_consignments (
	listing_id text primary key references public.store_listings (id),
	consignor_id uuid not null references public.store_consignors (id),
	commission_pct numeric(5, 2) not null check (commission_pct between 0 and 90),
	min_commission_brl numeric(10, 2) not null check (min_commission_brl between 0 and 1000),
	received_at timestamptz not null default now(),
	returned_at timestamptz,
	note text check (note is null or char_length(note) <= 500)
);

create index if not exists store_consignments_consignor on public.store_consignments (consignor_id);

-- One row per consigned card sold. listing_id is unique, so a payout is
-- never created twice for the same card.
create table if not exists public.store_payouts (
	id uuid primary key default gen_random_uuid(),
	listing_id text not null unique references public.store_listings (id),
	order_id uuid not null references public.store_orders (id),
	consignor_id uuid not null references public.store_consignors (id),
	sale_brl numeric(10, 2) not null check (sale_brl > 0),
	commission_brl numeric(10, 2) not null check (commission_brl >= 0),
	payout_brl numeric(10, 2) not null check (payout_brl >= 0),
	created_at timestamptz not null default now(),
	paid_at timestamptz,
	paid_note text check (paid_note is null or char_length(paid_note) <= 200),
	check (commission_brl + payout_brl = sale_brl)
);

create index if not exists store_payouts_consignor on public.store_payouts (consignor_id);

alter table public.store_settings enable row level security;
alter table public.store_consignors enable row level security;
alter table public.store_consignments enable row level security;
alter table public.store_payouts enable row level security;

revoke all on public.store_settings, public.store_consignors, public.store_consignments, public.store_payouts from anon;
revoke insert, update, delete on public.store_settings, public.store_consignors, public.store_consignments, public.store_payouts from authenticated;

drop policy if exists "store_settings: owner reads" on public.store_settings;
drop policy if exists "store_consignors: owner reads" on public.store_consignors;
drop policy if exists "store_consignments: owner reads" on public.store_consignments;
drop policy if exists "store_payouts: owner reads" on public.store_payouts;

create policy "store_settings: owner reads" on public.store_settings
	for select to authenticated
	using (private.is_store_owner());

create policy "store_consignors: owner reads" on public.store_consignors
	for select to authenticated
	using (private.is_store_owner());

create policy "store_consignments: owner reads" on public.store_consignments
	for select to authenticated
	using (private.is_store_owner());

create policy "store_payouts: owner reads" on public.store_payouts
	for select to authenticated
	using (private.is_store_owner());

-- ----------------------------------------------------------------- helpers

-- The commission on one sale: the percent, rounded to the centavo, at least
-- the minimum, and at most the price. R$ 100,00 at 15% with R$ 5,00 is
-- R$ 15,00; R$ 20,00 is R$ 5,00; R$ 4,00 is R$ 4,00.
create or replace function private.commission(price numeric, pct numeric, minimum numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
	select least(price, greatest(round(price * pct / 100, 2), minimum));
$$;

-- Owner-only guard, raised the same way by every call below.
create or replace function private.require_store_owner()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;
end;
$$;

-- Text from a JSON field: trimmed, null when empty, and refused when longer
-- than max.
create or replace function private.json_text(value jsonb, field text, max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
	clean text := nullif(btrim(coalesce(value ->> field, '')), '');
begin
	if clean is not null and char_length(clean) > max then
		raise exception '% is longer than % characters.', field, max using errcode = '22023';
	end if;

	return clean;
end;
$$;

-- A number from a JSON field, or null when absent; refused when not a
-- number.
create or replace function private.json_number(value jsonb, field text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
	if value -> field is null or jsonb_typeof(value -> field) = 'null' then
		return null;
	end if;

	if jsonb_typeof(value -> field) <> 'number' then
		raise exception '% must be a number.', field using errcode = '22023';
	end if;

	return (value ->> field)::numeric;
end;
$$;

-- One consigned card as the Shop shows it, with what it would pay out at its
-- current price.
create or replace function private.consigned_row(id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'id', l.id,
		'card_id', l.card_id,
		'catalog', l.catalog,
		'language', l.language,
		'finish', l.finish,
		'condition', l.condition,
		'name', l.name,
		'set_name', l.set_name,
		'number', l.number,
		'rarity', l.rarity,
		'image_path', l.image_path,
		'price_brl', l.price_brl,
		'status', case when c.returned_at is not null and l.status = 'withdrawn' then 'returned' else l.status end,
		'order_id', l.order_id,
		'consignor_id', c.consignor_id,
		'commission_pct', c.commission_pct,
		'min_commission_brl', c.min_commission_brl,
		'commission_brl', private.commission(l.price_brl, c.commission_pct, c.min_commission_brl),
		'payout_brl', l.price_brl - private.commission(l.price_brl, c.commission_pct, c.min_commission_brl),
		'received_at', c.received_at,
		'returned_at', c.returned_at,
		'note', c.note
	)
	from public.store_listings l
	join public.store_consignments c on c.listing_id = l.id
	where l.id = consigned_row.id;
$$;

revoke all on function private.commission(numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.require_store_owner() from public, anon, authenticated;
revoke all on function private.json_text(jsonb, text, integer) from public, anon, authenticated;
revoke all on function private.json_number(jsonb, text) from public, anon, authenticated;
revoke all on function private.consigned_row(text) from public, anon, authenticated;

-- --------------------------------------------------------------- pictures

-- The store bucket's path rule, as store-own-pictures.sql leaves it,
-- widened to consigned/<listing id>.webp or .jpg for the owner's own photo
-- of a consigned card. The bucket's policies (store.sql) call this
-- function, so they need no change.
create or replace function private.is_store_path(object_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select object_name ~ '^tcgdex/[a-z]{2}(-[a-z]{2})?/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.(webp|png)$'
		or object_name ~ '^sealed/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$'
		or object_name ~ '^sealed/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(webp|jpg|png)$'
		or object_name ~ '^own/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$'
		or object_name ~ '^consigned/cons-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$';
$$;

revoke all on function private.is_store_path(text) from public, anon;
grant execute on function private.is_store_path(text) to authenticated;

-- ----------------------------------------------------------- owner calls

-- The shop's default terms: {commission_pct, min_commission_brl}. Returns
-- them.
create or replace function public.save_store_settings(settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	pct numeric := private.json_number(settings, 'commission_pct');
	minimum numeric := private.json_number(settings, 'min_commission_brl');
begin
	perform private.require_store_owner();

	if pct is null or pct < 0 or pct > 90 then
		raise exception 'commission_pct must be between 0 and 90.' using errcode = '22023';
	end if;

	if minimum is null or minimum < 0 or minimum > 1000 then
		raise exception 'min_commission_brl must be between 0 and 1000.' using errcode = '22023';
	end if;

	update public.store_settings
	set commission_pct = round(pct, 2), min_commission_brl = round(minimum, 2), updated_at = now()
	where id;

	return (select jsonb_build_object('commission_pct', s.commission_pct, 'min_commission_brl', s.min_commission_brl) from public.store_settings s where s.id);
end;
$$;

-- Adds a consignor, or edits one when consignor has an id: {id?, name,
-- phone?, pix_key?, commission_pct?, min_commission_brl?, note?, active?}.
-- Null terms mean the shop's defaults. Returns the consignor.
create or replace function public.save_consignor(consignor jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	cid uuid;
	clean_name text := private.json_text(consignor, 'name', 80);
	pct numeric := private.json_number(consignor, 'commission_pct');
	minimum numeric := private.json_number(consignor, 'min_commission_brl');
	is_active boolean := coalesce((consignor ->> 'active')::boolean, true);
begin
	perform private.require_store_owner();

	if jsonb_typeof(consignor) is distinct from 'object' then
		raise exception 'consignor must be a JSON object.' using errcode = '22023';
	end if;

	if clean_name is null then
		raise exception 'A consignor needs a name.' using errcode = '22023';
	end if;

	if pct is not null and (pct < 0 or pct > 90) then
		raise exception 'commission_pct must be between 0 and 90.' using errcode = '22023';
	end if;

	if minimum is not null and (minimum < 0 or minimum > 1000) then
		raise exception 'min_commission_brl must be between 0 and 1000.' using errcode = '22023';
	end if;

	if nullif(consignor ->> 'id', '') is not null then
		cid := (consignor ->> 'id')::uuid;

		update public.store_consignors
		set
			name = clean_name,
			phone = private.json_text(consignor, 'phone', 40),
			pix_key = private.json_text(consignor, 'pix_key', 140),
			commission_pct = round(pct, 2),
			min_commission_brl = round(minimum, 2),
			note = private.json_text(consignor, 'note', 500),
			active = is_active,
			updated_at = now()
		where id = cid;

		if not found then
			raise exception 'No consignor %.', cid using errcode = 'P0002';
		end if;
	else
		insert into public.store_consignors (name, phone, pix_key, commission_pct, min_commission_brl, note, active)
		values (
			clean_name,
			private.json_text(consignor, 'phone', 40),
			private.json_text(consignor, 'pix_key', 140),
			round(pct, 2),
			round(minimum, 2),
			private.json_text(consignor, 'note', 500),
			is_active
		)
		returning id into cid;
	end if;

	return (select to_jsonb(c) - 'created_at' - 'updated_at' from public.store_consignors c where c.id = cid);
end;
$$;

-- Consigns a card, or edits a consigned card when card has an id:
-- {id?, consignor_id, card_id, catalog?, language?, finish?, condition?,
-- name, set_name?, number?, rarity?, image_path?, price_brl,
-- commission_pct?, min_commission_brl?, note?}. A new card is for sale on
-- HOTARU at once, and takes the terms given, else the consignor's, else the
-- shop's. An edit keeps the card's status and is refused once the card is
-- reserved or sold, so a closed order never changes; a picture path left out
-- keeps the one stored. Returns the card as store_consignment_admin lists
-- it.
create or replace function public.save_consigned(card jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	lid text := nullif(card ->> 'id', '');
	cid uuid;
	who public.store_consignors%rowtype;
	defaults public.store_settings%rowtype;
	price numeric := private.json_number(card, 'price_brl');
	pct numeric := private.json_number(card, 'commission_pct');
	minimum numeric := private.json_number(card, 'min_commission_brl');
	clean_name text := private.json_text(card, 'name', 160);
	current_status text;
begin
	perform private.require_store_owner();

	if jsonb_typeof(card) is distinct from 'object' then
		raise exception 'card must be a JSON object.' using errcode = '22023';
	end if;

	begin
		cid := (card ->> 'consignor_id')::uuid;
	exception when invalid_text_representation then
		cid := null;
	end;

	select * into who from public.store_consignors c where c.id = cid;

	if not found then
		raise exception 'No consignor %.', coalesce(card ->> 'consignor_id', '(none)') using errcode = '22023';
	end if;

	if clean_name is null then
		raise exception 'A consigned card needs a name.' using errcode = '22023';
	end if;

	if price is null or price <= 0 or price > 99999999 then
		raise exception 'price_brl must be above zero.' using errcode = '22023';
	end if;

	select * into defaults from public.store_settings s where s.id;

	pct := coalesce(pct, who.commission_pct, defaults.commission_pct);
	minimum := coalesce(minimum, who.min_commission_brl, defaults.min_commission_brl);

	if pct < 0 or pct > 90 then
		raise exception 'commission_pct must be between 0 and 90.' using errcode = '22023';
	end if;

	if minimum < 0 or minimum > 1000 then
		raise exception 'min_commission_brl must be between 0 and 1000.' using errcode = '22023';
	end if;

	if lid is null then
		lid := 'cons-' || gen_random_uuid()::text;

		insert into public.store_listings (id, kind, card_id, catalog, language, finish, condition, name, set_name, number, rarity, image_path, price_brl, status)
		values (
			lid,
			'consigned',
			private.json_text(card, 'card_id', 64),
			private.json_text(card, 'catalog', 32),
			private.json_text(card, 'language', 16),
			private.json_text(card, 'finish', 80),
			private.json_text(card, 'condition', 40),
			clean_name,
			private.json_text(card, 'set_name', 160),
			private.json_text(card, 'number', 32),
			private.json_text(card, 'rarity', 80),
			private.json_text(card, 'image_path', 200),
			round(price, 2),
			'available'
		);

		insert into public.store_consignments (listing_id, consignor_id, commission_pct, min_commission_brl, note)
		values (lid, cid, round(pct, 2), round(minimum, 2), private.json_text(card, 'note', 500));
	else
		select l.status into current_status
		from public.store_listings l
		where l.id = lid and l.kind = 'consigned'
		for update;

		if not found then
			raise exception 'No consigned card %.', lid using errcode = 'P0002';
		end if;

		if current_status not in ('available', 'withdrawn') then
			raise exception 'Card % is %, so it cannot change now.', lid, current_status using errcode = '22023';
		end if;

		update public.store_listings
		set
			card_id = private.json_text(card, 'card_id', 64),
			catalog = private.json_text(card, 'catalog', 32),
			language = private.json_text(card, 'language', 16),
			finish = private.json_text(card, 'finish', 80),
			condition = private.json_text(card, 'condition', 40),
			name = clean_name,
			set_name = private.json_text(card, 'set_name', 160),
			number = private.json_text(card, 'number', 32),
			rarity = private.json_text(card, 'rarity', 80),
			image_path = coalesce(private.json_text(card, 'image_path', 200), image_path),
			price_brl = round(price, 2),
			updated_at = now()
		where id = lid;

		update public.store_consignments
		set
			consignor_id = cid,
			commission_pct = round(pct, 2),
			min_commission_brl = round(minimum, 2),
			note = private.json_text(card, 'note', 500)
		where listing_id = lid;
	end if;

	return private.consigned_row(lid);
end;
$$;

-- Gives a card back to its owner: it leaves HOTARU and is marked returned.
-- Refused while an order holds it or after it is sold.
create or replace function public.return_consigned(listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_status text;
begin
	perform private.require_store_owner();

	select l.status into current_status
	from public.store_listings l
	where l.id = return_consigned.listing_id and l.kind = 'consigned'
	for update;

	if not found then
		raise exception 'No consigned card %.', return_consigned.listing_id using errcode = 'P0002';
	end if;

	if current_status not in ('available', 'withdrawn') then
		raise exception 'Card % is %, so it cannot be returned now.', return_consigned.listing_id, current_status using errcode = '22023';
	end if;

	update public.store_listings set status = 'withdrawn', updated_at = now() where id = return_consigned.listing_id;
	update public.store_consignments c set returned_at = coalesce(c.returned_at, now()) where c.listing_id = return_consigned.listing_id;

	return private.consigned_row(return_consigned.listing_id);
end;
$$;

-- Puts a returned card back on sale, as if consigned again today.
create or replace function public.relist_consigned(listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_status text;
begin
	perform private.require_store_owner();

	select l.status into current_status
	from public.store_listings l
	where l.id = relist_consigned.listing_id and l.kind = 'consigned'
	for update;

	if not found then
		raise exception 'No consigned card %.', relist_consigned.listing_id using errcode = 'P0002';
	end if;

	if current_status <> 'withdrawn' then
		raise exception 'Card % is %, not returned.', relist_consigned.listing_id, current_status using errcode = '22023';
	end if;

	update public.store_listings set status = 'available', published_at = now(), updated_at = now() where id = relist_consigned.listing_id;
	update public.store_consignments c set returned_at = null, received_at = now() where c.listing_id = relist_consigned.listing_id;

	return private.consigned_row(relist_consigned.listing_id);
end;
$$;

-- Records the Pix to a consignor for the given payouts, with an optional
-- note. A payout already paid keeps its first date. Returns how many were
-- marked.
create or replace function public.mark_payouts_paid(ids uuid[], note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	clean_note text := nullif(btrim(coalesce(note, '')), '');
	marked integer;
begin
	perform private.require_store_owner();

	if clean_note is not null and char_length(clean_note) > 200 then
		raise exception 'The note is longer than 200 characters.' using errcode = '22023';
	end if;

	update public.store_payouts p
	set paid_at = now(), paid_note = clean_note
	where p.id = any (coalesce(ids, '{}')) and p.paid_at is null;

	get diagnostics marked = row_count;

	return jsonb_build_object('marked', marked);
end;
$$;

-- Everything the Shop's Consignment section shows: the default terms, each
-- consignor with counts and balances, every consigned card, and every
-- payout with its state (waiting for delivery, due, or paid).
create or replace function public.store_consignment_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	perform private.require_store_owner();

	return jsonb_build_object(
		'settings', (select jsonb_build_object('commission_pct', s.commission_pct, 'min_commission_brl', s.min_commission_brl) from public.store_settings s where s.id),
		'consignors', coalesce((
			select jsonb_agg(
				(to_jsonb(c) - 'created_at' - 'updated_at') || jsonb_build_object(
					'for_sale', (select count(*) from public.store_consignments x join public.store_listings l on l.id = x.listing_id where x.consignor_id = c.id and l.status = 'available'),
					'reserved', (select count(*) from public.store_consignments x join public.store_listings l on l.id = x.listing_id where x.consignor_id = c.id and l.status = 'reserved'),
					'sold', (select count(*) from public.store_consignments x join public.store_listings l on l.id = x.listing_id where x.consignor_id = c.id and l.status = 'sold'),
					'returned', (select count(*) from public.store_consignments x join public.store_listings l on l.id = x.listing_id where x.consignor_id = c.id and l.status = 'withdrawn' and x.returned_at is not null),
					'waiting_brl', (select coalesce(sum(p.payout_brl), 0) from public.store_payouts p join public.store_orders o on o.id = p.order_id where p.consignor_id = c.id and p.paid_at is null and o.delivered_at is null),
					'due_brl', (select coalesce(sum(p.payout_brl), 0) from public.store_payouts p join public.store_orders o on o.id = p.order_id where p.consignor_id = c.id and p.paid_at is null and o.delivered_at is not null),
					'paid_brl', (select coalesce(sum(p.payout_brl), 0) from public.store_payouts p where p.consignor_id = c.id and p.paid_at is not null)
				)
				order by c.name
			)
			from public.store_consignors c
		), '[]'),
		'cards', coalesce((
			select jsonb_agg(private.consigned_row(x.listing_id) order by x.received_at desc)
			from public.store_consignments x
		), '[]'),
		'payouts', coalesce((
			select jsonb_agg(
				jsonb_build_object(
					'id', p.id,
					'listing_id', p.listing_id,
					'name', l.name,
					'consignor_id', p.consignor_id,
					'order_code', o.code,
					'sale_brl', p.sale_brl,
					'commission_brl', p.commission_brl,
					'payout_brl', p.payout_brl,
					'created_at', p.created_at,
					'delivered_at', o.delivered_at,
					'paid_at', p.paid_at,
					'paid_note', p.paid_note,
					'state', case when p.paid_at is not null then 'paid' when o.delivered_at is null then 'waiting' else 'due' end
				)
				order by p.created_at desc
			)
			from public.store_payouts p
			join public.store_orders o on o.id = p.order_id
			join public.store_listings l on l.id = p.listing_id
		), '[]')
	);
end;
$$;

-- Payment received, as in store-orders.sql, plus one payout for each
-- consigned card in the order, from the price the buyer paid for it and the
-- terms the card was consigned with.
create or replace function public.mark_paid(order_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	o public.store_orders%rowtype;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	perform private.release_expired();

	select * into o from public.store_orders where code = order_code for update;

	if not found then
		raise exception 'No order %.', order_code using errcode = 'P0002';
	end if;

	if o.status <> 'pending' then
		raise exception 'Order % is %, not waiting for payment.', order_code, o.status using errcode = '22023';
	end if;

	update public.store_orders set status = 'paid', paid_at = now(), ended_at = now() where id = o.id;
	update public.store_listings set status = 'sold', updated_at = now() where order_id = o.id and status = 'reserved';

	insert into public.store_payouts (listing_id, order_id, consignor_id, sale_brl, commission_brl, payout_brl)
	select
		i.listing_id,
		o.id,
		c.consignor_id,
		i.price_brl,
		private.commission(i.price_brl, c.commission_pct, c.min_commission_brl),
		i.price_brl - private.commission(i.price_brl, c.commission_pct, c.min_commission_brl)
	from public.store_order_items i
	join public.store_listings l on l.id = i.listing_id
	join public.store_consignments c on c.listing_id = i.listing_id
	where i.order_id = o.id and l.kind = 'consigned'
	on conflict (listing_id) do nothing;

	return jsonb_build_object('code', o.code, 'status', 'paid');
end;
$$;

-- ------------------------------------------------------------------ grants

-- Supabase grants new functions to anon by default, so each grant is
-- spelled out.
revoke all on function public.save_store_settings(jsonb) from public, anon;
revoke all on function public.save_consignor(jsonb) from public, anon;
revoke all on function public.save_consigned(jsonb) from public, anon;
revoke all on function public.return_consigned(text) from public, anon;
revoke all on function public.relist_consigned(text) from public, anon;
revoke all on function public.mark_payouts_paid(uuid[], text) from public, anon;
revoke all on function public.store_consignment_admin() from public, anon;
revoke all on function public.mark_paid(text) from public, anon;

grant execute on function public.save_store_settings(jsonb) to authenticated;
grant execute on function public.save_consignor(jsonb) to authenticated;
grant execute on function public.save_consigned(jsonb) to authenticated;
grant execute on function public.return_consigned(text) to authenticated;
grant execute on function public.relist_consigned(text) to authenticated;
grant execute on function public.mark_payouts_paid(uuid[], text) to authenticated;
grant execute on function public.store_consignment_admin() to authenticated;
grant execute on function public.mark_paid(text) to authenticated;
