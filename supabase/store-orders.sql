-- Card Tracker: orders for the HOTARU shop (plans/hotaru-catalog-plan.md,
-- sections 6 and 7, step 5).
--
-- What it does: creates the orders and their cards, the function a visitor
-- closes a cart with (place_order), the one that tells an open cart which of
-- its cards are still for sale (listing_status), and the owner's functions
-- for an order (mark_paid, mark_delivered, cancel_order). It also replaces
-- store_catalog from supabase/store.sql so that every public call first
-- lets expired reservations go.
--
-- Run it after supabase/store.sql. Where: Supabase dashboard, SQL Editor, New
-- query. Paste this whole file and click Run. Running it again is safe.
--
-- To check it worked: Table Editor lists store_orders and store_order_items;
-- Database, Functions lists place_order, listing_status, mark_paid,
-- mark_delivered, and cancel_order.
--
-- The rules (Eric, 2026-11-24):
--   - A cart reserves nothing. Whoever closes an order first gets its cards:
--     place_order reserves them in one statement, Postgres locks each row it
--     changes, so a second order closing at the same moment waits and then
--     finds the card taken. An order with any card taken reserves nothing and
--     says which cards were taken.
--   - A reserved card leaves the catalog until the order ends.
--   - A payment is the sale: mark_paid sets the order paid and its cards
--     sold. An order not paid within 48 hours expires, and its cards go back.
--     There is no scheduled job: every public call lets expired orders go
--     first, so the catalog is right whenever someone looks.
--   - Only the shop's owner reads orders, which hold buyers' names and phones.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_listings') is null or to_regprocedure('private.is_store_owner()') is null then
		raise exception 'Run supabase/store.sql first: this script uses its listings and owner rule.';
	end if;
end;
$$;

-- ------------------------------------------------------------------ tables

create sequence if not exists public.store_order_number;

create table if not exists public.store_orders (
	id uuid primary key default gen_random_uuid(),
	-- HTR-0001: what the buyer sees, and the Pix transaction ID without the
	-- hyphen (HTR0001).
	code text not null unique,
	name text not null check (char_length(name) between 1 and 80),
	phone text not null check (char_length(phone) between 1 and 40),
	note text check (note is null or char_length(note) <= 500),
	total numeric(10, 2) not null check (total > 0),
	status text not null default 'pending' check (status in ('pending', 'paid', 'cancelled', 'expired')),
	created_at timestamptz not null default now(),
	reserved_until timestamptz not null,
	paid_at timestamptz,
	delivered_at timestamptz,
	ended_at timestamptz
);

create index if not exists store_orders_pending on public.store_orders (reserved_until) where status = 'pending';

create table if not exists public.store_order_items (
	order_id uuid not null references public.store_orders (id) on delete cascade,
	listing_id text not null references public.store_listings (id),
	price_brl numeric(10, 2) not null check (price_brl > 0),
	primary key (order_id, listing_id)
);

alter table public.store_orders enable row level security;
alter table public.store_order_items enable row level security;

revoke all on public.store_orders, public.store_order_items from anon;
revoke insert, update, delete on public.store_orders, public.store_order_items from authenticated;
revoke all on sequence public.store_order_number from anon, authenticated;

drop policy if exists "store_orders: owner reads" on public.store_orders;
drop policy if exists "store_order_items: owner reads" on public.store_order_items;

create policy "store_orders: owner reads" on public.store_orders
	for select to authenticated
	using (private.is_store_owner());

create policy "store_order_items: owner reads" on public.store_order_items
	for select to authenticated
	using (private.is_store_owner());

-- ----------------------------------------------------------------- helpers

-- How long a closed order holds its cards before it expires unpaid.
create or replace function private.store_hold()
returns interval
language sql
immutable
set search_path = ''
as $$
	select interval '48 hours';
$$;

-- Lets every pending order past its time expire and puts its cards back.
create or replace function private.release_expired()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	with gone as (
		update public.store_orders o
		set status = 'expired', ended_at = now()
		where o.status = 'pending' and o.reserved_until < now()
		returning o.id
	)
	update public.store_listings l
	set status = 'available', order_id = null, updated_at = now()
	from gone
	where l.order_id = gone.id and l.status = 'reserved';
end;
$$;

revoke all on function private.store_hold() from public, anon;
revoke all on function private.release_expired() from public, anon;
grant execute on function private.store_hold() to authenticated;
grant execute on function private.release_expired() to authenticated;

-- ---------------------------------------------------------- public calls

-- What a visitor sees: the available listings only. Replaces the one in
-- supabase/store.sql, so that expired reservations go back first.
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
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform private.release_expired();

	return query
	select l.id, l.kind, l.card_id, l.catalog, l.language, l.finish, l.condition, l.name, l.set_name, l.number, l.rarity, l.description, l.image_path, l.price_brl, l.published_at
	from public.store_listings l
	where l.status = 'available'
	order by l.set_name nulls last, l.number, l.name, l.id;
end;
$$;

-- For an open cart: {<id>: 'available' | 'reserved' | 'gone'} for each ID
-- asked about. gone is sold, withdrawn, or unknown. Nothing about who holds
-- a reserved card is returned.
create or replace function public.listing_status(ids text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	result jsonb;
begin
	if ids is null or cardinality(ids) > 100 then
		raise exception 'Ask about 1 to 100 cards.' using errcode = '22023';
	end if;

	perform private.release_expired();

	select coalesce(jsonb_object_agg(asked.id, case
		when l.status = 'available' then 'available'
		when l.status = 'reserved' then 'reserved'
		else 'gone'
	end), '{}')
	into result
	from unnest(ids) as asked(id)
	left join public.store_listings l on l.id = asked.id;

	return result;
end;
$$;

-- Closes a cart: reserves every card in items for a new order, or none.
-- Returns {code, total, reserved_until} on success, or {unavailable: [ids]}
-- when any card was taken (reserved, sold, or withdrawn) and nothing was
-- reserved. The total is the listings' own prices, never the page's.
create or replace function public.place_order(items text[], buyer_name text, buyer_phone text, buyer_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	clean_name text := btrim(coalesce(buyer_name, ''));
	clean_phone text := btrim(coalesce(buyer_phone, ''));
	clean_note text := nullif(btrim(coalesce(buyer_note, '')), '');
	wanted text[];
	got text[];
	order_row public.store_orders%rowtype;
	sum_brl numeric(10, 2);
	taken text[];
begin
	select coalesce(array_agg(distinct x), '{}') into wanted from unnest(items) as x where x is not null;

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
			returning l.id, l.price_brl
		), items_in as (
			insert into public.store_order_items (order_id, listing_id, price_brl)
			select order_row.id, won.id, won.price_brl from won
			returning listing_id, price_brl
		)
		select array_agg(listing_id), sum(price_brl) into got, sum_brl from items_in;

		got := coalesce(got, '{}');

		if cardinality(got) < cardinality(wanted) then
			select coalesce(array_agg(x), '{}') into taken from unnest(wanted) as x where not (x = any (got));
			raise exception using errcode = 'P0001', message = 'store:taken';
		end if;

		update public.store_orders set total = sum_brl where id = order_row.id;
	exception
		when raise_exception then
			if sqlerrm = 'store:taken' then
				-- Everything inside the block is undone: no order, nothing reserved.
				return jsonb_build_object('unavailable', to_jsonb(taken));
			end if;

			raise;
	end;

	return jsonb_build_object('code', order_row.code, 'reserved_until', order_row.reserved_until, 'total', sum_brl);
end;
$$;

-- ------------------------------------------------------- the owner's calls

-- Payment received: the order is paid and its cards sold, for good. Refused
-- unless the order is still pending (an expired one has let its cards go).
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

	return jsonb_build_object('code', o.code, 'status', 'paid');
end;
$$;

-- Delivered: a reminder only, on a paid order. Changes no card.
create or replace function public.mark_delivered(order_code text)
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

	select * into o from public.store_orders where code = order_code for update;

	if not found or o.status <> 'paid' then
		raise exception 'Order % is not paid.', order_code using errcode = '22023';
	end if;

	update public.store_orders set delivered_at = coalesce(delivered_at, now()) where id = o.id;

	return jsonb_build_object('code', o.code, 'delivered', true);
end;
$$;

-- Cancel: the owner refuses a pending order, and its cards go back at once.
create or replace function public.cancel_order(order_code text)
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

	select * into o from public.store_orders where code = order_code for update;

	if not found or o.status <> 'pending' then
		raise exception 'Order % is not pending.', order_code using errcode = '22023';
	end if;

	update public.store_orders set status = 'cancelled', ended_at = now() where id = o.id;
	update public.store_listings set status = 'available', order_id = null, updated_at = now() where order_id = o.id and status = 'reserved';

	return jsonb_build_object('code', o.code, 'status', 'cancelled');
end;
$$;

-- Supabase grants new functions to anon by default, so each grant is
-- spelled out.
revoke all on function public.store_catalog() from public;
revoke all on function public.listing_status(text[]) from public;
revoke all on function public.place_order(text[], text, text, text) from public;
revoke all on function public.mark_paid(text) from public, anon;
revoke all on function public.mark_delivered(text) from public, anon;
revoke all on function public.cancel_order(text) from public, anon;

grant execute on function public.store_catalog() to anon, authenticated;
grant execute on function public.listing_status(text[]) to anon, authenticated;
grant execute on function public.place_order(text[], text, text, text) to anon, authenticated;
grant execute on function public.mark_paid(text) to authenticated;
grant execute on function public.mark_delivered(text) to authenticated;
grant execute on function public.cancel_order(text) to authenticated;
