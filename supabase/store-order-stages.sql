-- Card Tracker: the stages of a HOTARU order on the Shop's Orders tab (v122).
--
-- What it does: keeps the order checklist's ticks on the server, so a card
-- ticked on the phone shows ticked on the computer too (v119 kept them on
-- each device), and lists the orders delivered lately. The Shop derives an
-- order's stage from these: Unpaid (pending), Separating (paid, some card
-- not ticked), Ready (paid, every card ticked), and Delivered. No new order
-- status: store_orders.status keeps its four values, and a tick moves an
-- order from Separating to Ready by itself.
--
-- Run it after supabase/store.sql, store-orders.sql, store-sealed.sql, and
-- store-bundles.sql. Where: Supabase dashboard, SQL Editor, New query.
-- Paste this whole file and click Run. Running it again is safe, and
-- running an older script again afterwards leaves this one working.
--
-- To check it worked: Table Editor, store_order_items has a checked_at
-- column; Database, Functions lists store_order_checks, set_order_check,
-- and store_orders_delivered.
--
-- Why its own calls rather than a field on store_orders_open: that function
-- is written again by store-sealed.sql and store-bundles.sql, so a field
-- added to it would vanish the next time either is run.
--
-- The rules (Eric, 2026-11-26):
--   - Only the shop's owner reads or writes ticks, as with every order call.
--   - A card can be ticked while its order is open: waiting for payment, or
--     paid and not delivered. A delivered or ended order's ticks stay as
--     they were, and nothing reads them.
--   - Delivered lists the orders handed over in the last 30 days by
--     default (at most 366), newest first. The full history is the sales in
--     Trades.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_order_items') is null or to_regprocedure('private.is_store_owner()') is null then
		raise exception 'Run supabase/store.sql and supabase/store-orders.sql first: this script uses their orders.';
	end if;

	if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'store_order_items' and column_name = 'bundle_id') then
		raise exception 'Run supabase/store-bundles.sql first: this script lists orders with their kits.';
	end if;
end;
$$;

-- ------------------------------------------------------------------ column

-- When the owner ticked the card off while putting the order together; null
-- when not ticked.
alter table public.store_order_items add column if not exists checked_at timestamptz;

-- ------------------------------------------------------- the owner's calls

-- The ticked cards of every open order, as {order code: [listing IDs]}. An
-- order with nothing ticked is left out.
create or replace function public.store_order_checks()
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

	select coalesce(jsonb_object_agg(ticked.code, ticked.listings), '{}')
	into result
	from (
		select o.code, jsonb_agg(i.listing_id order by i.listing_id) as listings
		from public.store_orders o
		join public.store_order_items i on i.order_id = o.id
		where (o.status = 'pending' or (o.status = 'paid' and o.delivered_at is null))
			and i.checked_at is not null
		group by o.code
	) ticked;

	return result;
end;
$$;

-- Ticks one card of an open order, or unticks it. Refused for a card not in
-- the order, and for an order no longer open.
create or replace function public.set_order_check(order_code text, listing text, checked boolean)
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

	select * into o from public.store_orders where code = order_code;

	if not found then
		raise exception 'No order %.', order_code using errcode = 'P0002';
	end if;

	if not (o.status = 'pending' or (o.status = 'paid' and o.delivered_at is null)) then
		raise exception 'Order % is no longer open.', order_code using errcode = '22023';
	end if;

	update public.store_order_items
	set checked_at = case when checked then coalesce(checked_at, now()) else null end
	where order_id = o.id and listing_id = listing;

	if not found then
		raise exception 'Order % has no card %.', order_code, listing using errcode = 'P0002';
	end if;

	return jsonb_build_object('checked', coalesce(checked, false), 'code', o.code, 'listing_id', listing);
end;
$$;

-- The orders delivered in the last `days` days (1 to 366), newest first,
-- each with its cards, in store_orders_open's shape plus delivered_at.
create or replace function public.store_orders_delivered(days integer default 30)
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

	if days is null or days < 1 or days > 366 then
		raise exception 'Days must be from 1 to 366.' using errcode = '22023';
	end if;

	select coalesce(jsonb_agg(jsonb_build_object(
		'code', o.code,
		'created_at', o.created_at,
		'delivered_at', o.delivered_at,
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
		'status', o.status,
		'total', o.total
	) order by o.delivered_at desc), '[]')
	into result
	from public.store_orders o
	where o.status = 'paid' and o.delivered_at >= now() - make_interval(days => days);

	return result;
end;
$$;

-- Supabase grants new functions to anon by default, so each grant is
-- spelled out.
revoke all on function public.store_order_checks() from public, anon;
revoke all on function public.set_order_check(text, text, boolean) from public, anon;
revoke all on function public.store_orders_delivered(integer) from public, anon;

grant execute on function public.store_order_checks() to authenticated;
grant execute on function public.set_order_check(text, text, boolean) to authenticated;
grant execute on function public.store_orders_delivered(integer) to authenticated;
