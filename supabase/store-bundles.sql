-- Card Tracker: kits for the HOTARU shop (plans/hotaru-bundles-plan.md).
--
-- What it does: creates kits, several cards sold together at a price that
-- is not their sum (Eric, 2026-11-25: the three MEP Black Star Promo
-- starters as a trio). A kit's price is either one Eric types or a percent
-- off the sum of its cards' prices. It adds the owner's calls that save,
-- delete, and list kits, the one public call HOTARU's Kits section reads
-- (store_bundles), and lets place_order take kits.
--
-- Run it after supabase/store.sql, store-orders.sql, and store-sealed.sql.
-- Where: Supabase dashboard, SQL Editor, New query. Paste this whole file
-- and click Run. Running it again is safe.
--
-- To check it worked: Table Editor lists store_bundles and
-- store_bundle_items; Database, Functions lists save_bundle, delete_bundle,
-- store_bundles_admin, and store_bundles.
--
-- This script replaces four functions an earlier script also defines:
-- store_catalog (store-orders.sql), place_order (store-orders.sql), and
-- order_status and store_orders_open (store-orders.sql, then
-- store-sealed.sql). Whichever script ran last wins, so after running one of
-- those again, run this one again too.
--
-- The rules (Eric, 2026-11-25):
--   - A kit names exact copies: the condition HOTARU shows is the one that
--     ships. Its cards stay for sale one by one too, and whoever closes an
--     order first gets the copy, as today.
--   - A kit is for sale while every one of its copies is available. When one
--     is reserved, sold, or withdrawn, the kit leaves the catalog; it comes
--     back when that order is cancelled or expires, or when the Shop puts
--     another copy of the same card in its place.
--   - A percent kit costs the sum of its cards' current prices minus the
--     percent, rounded down to the centavo (R$ 15,00 at 5% is R$ 14,25), so
--     the buyer always gets at least the discount shown.
--   - An order splits a kit's price over its cards in proportion to their
--     prices, with the centavos left over on the dearest card, so the cards'
--     prices still add up to the order's total.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_products') is null then
		raise exception 'Run supabase/store-sealed.sql first: this script replaces calls it defines.';
	end if;
end;
$$;

-- ------------------------------------------------------------------ tables

create table if not exists public.store_bundles (
	id uuid primary key default gen_random_uuid(),
	name text not null check (char_length(name) between 1 and 80),
	description text check (description is null or char_length(description) <= 500),
	price_mode text not null check (price_mode in ('fixed', 'percent')),
	price_brl numeric(10, 2) check (price_brl is null or price_brl > 0),
	discount_pct numeric(4, 1) check (discount_pct is null or discount_pct between 1 and 90),
	active boolean not null default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	check ((price_mode = 'fixed' and price_brl is not null) or (price_mode = 'percent' and discount_pct is not null))
);

create table if not exists public.store_bundle_items (
	bundle_id uuid not null references public.store_bundles (id) on delete cascade,
	listing_id text not null references public.store_listings (id),
	position smallint not null,
	primary key (bundle_id, listing_id)
);

create index if not exists store_bundle_items_listing on public.store_bundle_items (listing_id);

-- An order keeps the kit's name, so it reads the same after the kit is
-- deleted.
alter table public.store_order_items add column if not exists bundle_id uuid;
alter table public.store_order_items add column if not exists bundle_name text;

alter table public.store_bundles enable row level security;
alter table public.store_bundle_items enable row level security;

revoke all on public.store_bundles, public.store_bundle_items from anon;
revoke insert, update, delete on public.store_bundles, public.store_bundle_items from authenticated;

drop policy if exists "store_bundles: owner reads" on public.store_bundles;
drop policy if exists "store_bundle_items: owner reads" on public.store_bundle_items;

create policy "store_bundles: owner reads" on public.store_bundles
	for select to authenticated
	using (private.is_store_owner());

create policy "store_bundle_items: owner reads" on public.store_bundle_items
	for select to authenticated
	using (private.is_store_owner());

-- ----------------------------------------------------------------- helpers

-- A kit's price from its rule and the sum of its cards' prices.
create or replace function private.bundle_price(price_mode text, price_brl numeric, discount_pct numeric, sum_brl numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
	select case
		when price_mode = 'fixed' then price_brl
		else greatest(floor(sum_brl * (100 - discount_pct)) / 100, 0.01)
	end::numeric(10, 2);
$$;

-- One kit as the owner's Shop sees it: its rule, its cards with each one's
-- status, the sum, the price, and whether HOTARU shows it now.
create or replace function private.bundle_row(kit_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'active', b.active,
		'available', b.active and bool_and(l.status = 'available'),
		'created_at', b.created_at,
		'description', b.description,
		'discount_pct', b.discount_pct,
		'id', b.id,
		'items', jsonb_agg(jsonb_build_object(
			'card_id', l.card_id,
			'condition', l.condition,
			'finish', l.finish,
			'image_path', l.image_path,
			'language', l.language,
			'listing_id', l.id,
			'name', l.name,
			'number', l.number,
			'price_brl', l.price_brl,
			'set_name', l.set_name,
			'status', l.status
		) order by i.position),
		'name', b.name,
		'price', private.bundle_price(b.price_mode, b.price_brl, b.discount_pct, sum(l.price_brl)),
		'price_brl', b.price_brl,
		'price_mode', b.price_mode,
		'sum', sum(l.price_brl)
	)
	from public.store_bundles b
	join public.store_bundle_items i on i.bundle_id = b.id
	join public.store_listings l on l.id = i.listing_id
	where b.id = kit_id
	group by b.id;
$$;

revoke all on function private.bundle_price(text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function private.bundle_row(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------- owner calls

-- Saves a kit. kit: {id?, name, description?, price_mode: 'fixed' |
-- 'percent', price_brl (fixed), discount_pct (percent), active?, items:
-- [listing IDs, in the order shown]}. The items are 2 to 20 different
-- singles that exist in any status: a kit may name a copy that is reserved
-- right now, and is simply not for sale until it is available again. Saving
-- replaces the kit's cards, which is how the Shop puts another copy in place
-- of one that sold. Returns the kit as store_bundles_admin lists it.
create or replace function public.save_bundle(kit jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	kit_id uuid;
	clean_name text := btrim(coalesce(kit ->> 'name', ''));
	clean_description text := nullif(btrim(coalesce(kit ->> 'description', '')), '');
	mode text := kit ->> 'price_mode';
	fixed numeric;
	percent numeric;
	ids text[];
	known int;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	if char_length(clean_name) not between 1 and 80 then
		raise exception 'Type a kit name of up to 80 characters.' using errcode = '22023';
	end if;

	if clean_description is not null and char_length(clean_description) > 500 then
		raise exception 'The description holds up to 500 characters.' using errcode = '22023';
	end if;

	if mode = 'fixed' then
		fixed := round((kit ->> 'price_brl')::numeric, 2);

		if fixed is null or fixed <= 0 or fixed > 99999999 then
			raise exception 'Type the kit''s price.' using errcode = '22023';
		end if;
	elsif mode = 'percent' then
		percent := round((kit ->> 'discount_pct')::numeric, 1);

		if percent is null or percent not between 1 and 90 then
			raise exception 'Type a discount from 1%% to 90%%.' using errcode = '22023';
		end if;
	else
		raise exception 'A kit is priced as fixed or percent.' using errcode = '22023';
	end if;

	if jsonb_typeof(kit -> 'items') is distinct from 'array' then
		raise exception 'A kit holds 2 to 20 cards.' using errcode = '22023';
	end if;

	select array_agg(x order by n) into ids
	from jsonb_array_elements_text(kit -> 'items') with ordinality as t(x, n);

	if cardinality(ids) not between 2 and 20 or (select count(distinct x) from unnest(ids) as x) <> cardinality(ids) then
		raise exception 'A kit holds 2 to 20 different cards.' using errcode = '22023';
	end if;

	select count(*) into known from public.store_listings l where l.id = any (ids) and l.kind = 'single';

	if known <> cardinality(ids) then
		raise exception 'A kit holds only cards that are listed on HOTARU.' using errcode = '22023';
	end if;

	kit_id := nullif(kit ->> 'id', '')::uuid;

	if kit_id is not null and exists (select 1 from public.store_bundles b where b.id = kit_id) then
		update public.store_bundles
		set name = clean_name, description = clean_description, price_mode = mode, price_brl = fixed, discount_pct = percent, active = coalesce((kit ->> 'active')::boolean, active), updated_at = now()
		where id = kit_id;

		delete from public.store_bundle_items where bundle_id = kit_id;
	else
		insert into public.store_bundles (id, name, description, price_mode, price_brl, discount_pct, active)
		values (coalesce(kit_id, gen_random_uuid()), clean_name, clean_description, mode, fixed, percent, coalesce((kit ->> 'active')::boolean, true))
		returning id into kit_id;
	end if;

	insert into public.store_bundle_items (bundle_id, listing_id, position)
	select kit_id, x, n
	from unnest(ids) with ordinality as t(x, n);

	return private.bundle_row(kit_id);
end;
$$;

-- Deletes a kit. Its cards stay listed, and past orders keep the kit's name.
-- Returns whether a kit was deleted.
create or replace function public.delete_bundle(kit_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	delete from public.store_bundles where id = kit_id;

	return found;
end;
$$;

-- Every kit, newest first, each with its cards' status: for the Shop.
create or replace function public.store_bundles_admin()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	result jsonb;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	perform private.release_expired();

	select coalesce(jsonb_agg(private.bundle_row(b.id) order by b.created_at desc), '[]')
	into result
	from public.store_bundles b;

	return result;
end;
$$;

-- ----------------------------------------------------------- public calls

-- What HOTARU's Kits section shows: every active kit whose copies are all
-- available, newest first, with its cards, the sum, the price, and the
-- percent for a percent kit. Nothing about a copy's status or a kit that is
-- off is returned. Expired orders let their cards go first.
create or replace function public.store_bundles()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	result jsonb;
begin
	perform private.release_expired();

	select coalesce(jsonb_agg(jsonb_build_object(
		'description', r.kit ->> 'description',
		'discount_pct', case when r.kit ->> 'price_mode' = 'percent' then (r.kit -> 'discount_pct') end,
		'id', r.kit -> 'id',
		'items', (
			select jsonb_agg(item - 'status')
			from jsonb_array_elements(r.kit -> 'items') as item
		),
		'name', r.kit -> 'name',
		'price', r.kit -> 'price',
		'sum', r.kit -> 'sum'
	) order by r.created_at desc), '[]')
	into result
	from (
		select private.bundle_row(b.id) as kit, b.created_at
		from public.store_bundles b
		where b.active
	) r
	where (r.kit ->> 'available')::boolean;

	return result;
end;
$$;

-- What a visitor sees: the available listings only, each saying whether a
-- kit that is on holds it (in_kit), so HOTARU sells a single from the copies
-- outside kits first. Replaces the one in supabase/store-orders.sql.
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
	published_at timestamptz,
	in_kit boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform private.release_expired();

	return query
	select l.id, l.kind, l.card_id, l.catalog, l.language, l.finish, l.condition, l.name, l.set_name, l.number, l.rarity, l.description, l.image_path, l.price_brl, l.published_at,
		exists (
			select 1
			from public.store_bundle_items i
			join public.store_bundles b on b.id = i.bundle_id
			where i.listing_id = l.id and b.active
		)
	from public.store_listings l
	where l.status = 'available'
	order by l.set_name nulls last, l.number, l.name, l.id;
end;
$$;

-- Closes a cart: reserves every card in items and every card of the kits in
-- bundles for a new order, or none. Returns {code, receipt_token,
-- reserved_until, total} on success, or {unavailable: [listing IDs],
-- unavailable_kits: [kit IDs]} when any card was taken (reserved, sold, or
-- withdrawn), or a kit is off or deleted, and nothing was reserved. The
-- total is the listings' own prices and the kits' own rules, never the
-- page's. Replaces the one in supabase/store-orders.sql; bundles comes last
-- and defaults to none, so a page that does not know kits still orders.
drop function if exists public.place_order(text[], text, text, text);

create or replace function public.place_order(items text[], buyer_name text, buyer_phone text, buyer_note text default null, bundles uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	clean_name text := btrim(coalesce(buyer_name, ''));
	clean_phone text := btrim(coalesce(buyer_phone, ''));
	clean_note text := nullif(btrim(coalesce(buyer_note, '')), '');
	singles text[];
	kits uuid[];
	kit_cards text[];
	wanted text[];
	got text[];
	order_row public.store_orders%rowtype;
	sum_brl numeric(10, 2);
	taken text[];
	taken_kits uuid[];
begin
	select coalesce(array_agg(distinct x), '{}') into singles from unnest(coalesce(items, '{}')) as x where x is not null;
	select coalesce(array_agg(distinct x), '{}') into kits from unnest(coalesce(bundles, '{}')) as x where x is not null;

	if cardinality(kits) > 10 then
		raise exception 'An order holds up to 10 kits.' using errcode = '22023';
	end if;

	select coalesce(array_agg(i.listing_id), '{}') into kit_cards
	from public.store_bundle_items i
	where i.bundle_id = any (kits);

	-- A card ordered both alone and in a kit, or in two kits, would be
	-- charged twice for one copy.
	if (select count(distinct x) from unnest(kit_cards) as x) <> cardinality(kit_cards) or singles && kit_cards then
		raise exception 'A card is in the order twice.' using errcode = '22023';
	end if;

	wanted := singles || kit_cards;

	if cardinality(wanted) = 0 or cardinality(wanted) > 20 then
		raise exception 'An order holds 1 to 20 cards.' using errcode = '22023';
	end if;

	if char_length(clean_name) not between 1 and 80 then
		raise exception 'Type a name of up to 80 characters.' using errcode = '22023';
	end if;

	if char_length(clean_phone) not between 1 and 40 then
		raise exception 'Type a phone number of up to 40 characters.' using errcode = '22023';
	end if;

	if clean_note is not null and char_length(clean_note) > 500 then
		raise exception 'The note holds up to 500 characters.' using errcode = '22023';
	end if;

	perform private.release_expired();

	-- A kit that is off or no longer exists is not for sale.
	select coalesce(array_agg(k), '{}') into taken_kits
	from unnest(kits) as k
	where not exists (select 1 from public.store_bundles b where b.id = k and b.active);

	if cardinality(taken_kits) > 0 then
		return jsonb_build_object('unavailable', '[]'::jsonb, 'unavailable_kits', to_jsonb(taken_kits));
	end if;

	begin
		insert into public.store_orders (code, name, phone, note, total, reserved_until)
		values ('HTR-' || lpad(nextval('public.store_order_number')::text, 4, '0'), clean_name, clean_phone, clean_note, 0.01, now() + private.store_hold())
		returning * into order_row;

		-- The race is settled here: each row is locked as it is changed, and
		-- a second order waiting on it sees it reserved and skips it.
		with won as (
			update public.store_listings l
			set status = 'reserved', order_id = order_row.id, updated_at = now()
			where l.id = any (wanted) and l.status = 'available'
			returning l.id
		)
		select coalesce(array_agg(id), '{}') into got from won;

		if cardinality(got) < cardinality(wanted) then
			select coalesce(array_agg(x), '{}') into taken from unnest(wanted) as x where not (x = any (got));
			select coalesce(array_agg(distinct i.bundle_id), '{}') into taken_kits from public.store_bundle_items i where i.bundle_id = any (kits) and i.listing_id = any (taken);
			raise exception using errcode = 'P0001', message = 'store:taken';
		end if;

		-- Singles at their own price; a kit's price split over its cards in
		-- proportion to theirs, rounded down, with what is left over on the
		-- dearest card.
		insert into public.store_order_items (order_id, listing_id, price_brl, bundle_id, bundle_name)
		select order_row.id, l.id, l.price_brl, null, null
		from public.store_listings l
		where l.id = any (singles)
		union all
		select order_row.id, s.listing_id, s.share + case when s.rank = 1 then s.kit_price - sum(s.share) over (partition by s.bundle_id) else 0 end, s.bundle_id, s.bundle_name
		from (
			select p.*, greatest(floor(p.price_brl * p.kit_price / p.sum_brl * 100) / 100, 0.01) as share, row_number() over (partition by p.bundle_id order by p.price_brl desc, p.position) as rank
			from (
				select i.bundle_id, b.name as bundle_name, i.listing_id, i.position, l.price_brl, sum(l.price_brl) over (partition by i.bundle_id) as sum_brl,
					private.bundle_price(b.price_mode, b.price_brl, b.discount_pct, sum(l.price_brl) over (partition by i.bundle_id)) as kit_price
				from public.store_bundle_items i
				join public.store_bundles b on b.id = i.bundle_id
				join public.store_listings l on l.id = i.listing_id
				where i.bundle_id = any (kits)
			) p
		) s;

		select sum(i.price_brl) into sum_brl from public.store_order_items i where i.order_id = order_row.id;

		update public.store_orders set total = sum_brl where id = order_row.id;
	exception
		when raise_exception then
			if sqlerrm = 'store:taken' then
				-- Everything inside the block is undone: no order, nothing reserved.
				return jsonb_build_object('unavailable', to_jsonb(taken), 'unavailable_kits', to_jsonb(taken_kits));
			end if;

			raise;
	end;

	return jsonb_build_object('code', order_row.code, 'receipt_token', order_row.receipt_token, 'reserved_until', order_row.reserved_until, 'total', sum_brl);
end;
$$;

-- ------------------------------------------------- the order calls, again

-- As in supabase/store-sealed.sql, each item now also naming its kit
-- (bundle_id and bundle_name, both null for a single), so the Shop and My
-- orders group a kit's cards under its name.

create or replace function public.order_status(tokens uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	result jsonb;
begin
	if tokens is null or cardinality(tokens) > 50 then
		raise exception 'Ask about 1 to 50 orders.' using errcode = '22023';
	end if;

	perform private.release_expired();

	select coalesce(jsonb_agg(jsonb_build_object(
		'code', o.code,
		'created_at', o.created_at,
		'delivered_at', o.delivered_at,
		'items', (
			select coalesce(jsonb_agg(jsonb_build_object(
				'bundle_id', i.bundle_id,
				'bundle_name', i.bundle_name,
				'card_id', l.card_id,
				'condition', l.condition,
				'finish', l.finish,
				'image_path', l.image_path,
				'kind', l.kind,
				'language', l.language,
				'name', l.name,
				'number', l.number,
				'price_brl', i.price_brl,
				'set_name', l.set_name
			) order by i.bundle_name nulls first, l.set_name, l.number, l.name), '[]')
			from public.store_order_items i
			join public.store_listings l on l.id = i.listing_id
			where i.order_id = o.id
		),
		'paid_at', o.paid_at,
		'receipt_at', o.receipt_at,
		'reserved_until', o.reserved_until,
		'status', o.status,
		'token', o.receipt_token,
		'total', o.total
	) order by o.created_at desc), '[]')
	into result
	from public.store_orders o
	where o.receipt_token = any (tokens);

	return result;
end;
$$;

create or replace function public.store_orders_open()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	result jsonb;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	perform private.release_expired();

	select coalesce(jsonb_agg(jsonb_build_object(
		'code', o.code,
		'created_at', o.created_at,
		'id', o.id,
		'items', (
			select coalesce(jsonb_agg(jsonb_build_object(
				'bundle_id', i.bundle_id,
				'bundle_name', i.bundle_name,
				'card_id', l.card_id,
				'condition', l.condition,
				'finish', l.finish,
				'kind', l.kind,
				'language', l.language,
				'listing_id', i.listing_id,
				'name', l.name,
				'number', l.number,
				'price_brl', i.price_brl,
				'set_name', l.set_name
			) order by i.bundle_name nulls first, l.set_name, l.number, l.name), '[]')
			from public.store_order_items i
			join public.store_listings l on l.id = i.listing_id
			where i.order_id = o.id
		),
		'name', o.name,
		'note', o.note,
		'paid_at', o.paid_at,
		'phone', o.phone,
		'receipt_at', o.receipt_at,
		'receipt_path', o.receipt_path,
		'reserved_until', o.reserved_until,
		'status', o.status,
		'total', o.total
	) order by o.created_at), '[]')
	into result
	from public.store_orders o
	where o.status = 'pending' or (o.status = 'paid' and o.delivered_at is null);

	return result;
end;
$$;

-- Supabase grants new functions to anon by default, so each grant is
-- spelled out.
revoke all on function public.save_bundle(jsonb) from public, anon;
revoke all on function public.delete_bundle(uuid) from public, anon;
revoke all on function public.store_bundles_admin() from public, anon;
revoke all on function public.store_bundles() from public;
revoke all on function public.store_catalog() from public;
revoke all on function public.place_order(text[], text, text, text, uuid[]) from public;
revoke all on function public.order_status(uuid[]) from public;
revoke all on function public.store_orders_open() from public, anon;

grant execute on function public.save_bundle(jsonb) to authenticated;
grant execute on function public.delete_bundle(uuid) to authenticated;
grant execute on function public.store_bundles_admin() to authenticated;
grant execute on function public.store_bundles() to anon, authenticated;
grant execute on function public.store_catalog() to anon, authenticated;
grant execute on function public.place_order(text[], text, text, text, uuid[]) to anon, authenticated;
grant execute on function public.order_status(uuid[]) to anon, authenticated;
grant execute on function public.store_orders_open() to authenticated;
