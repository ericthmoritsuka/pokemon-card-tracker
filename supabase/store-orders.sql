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
-- Database, Functions lists place_order, listing_status, attach_receipt,
-- order_status, store_orders_open, mark_paid, mark_delivered, and
-- cancel_order; Storage lists store-receipts,
-- marked Private.
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
--   - After ordering, the buyer may attach the payment receipt (Eric,
--     2026-11-24, as Liga Pokémon does), so Eric can check it against the
--     money that arrived. place_order returns a secret receipt token; the
--     private store-receipts bucket takes a file only under the token of an
--     order still waiting for payment, so nobody attaches a file to someone
--     else's order by guessing its code. Only the owner reads receipts.

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
	ended_at timestamptz,
	-- The buyer's secret for attaching the receipt; never shown to anyone
	-- else, and useless once the order is no longer pending.
	receipt_token uuid not null default gen_random_uuid() unique,
	receipt_path text check (receipt_path is null or char_length(receipt_path) <= 200),
	receipt_at timestamptz
);

-- A table made by an earlier run of this script gains the receipt columns.
alter table public.store_orders add column if not exists receipt_token uuid not null default gen_random_uuid();
alter table public.store_orders add column if not exists receipt_path text;
alter table public.store_orders add column if not exists receipt_at timestamptz;

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

	return jsonb_build_object('code', order_row.code, 'receipt_token', order_row.receipt_token, 'reserved_until', order_row.reserved_until, 'total', sum_brl);
end;
$$;

-- ---------------------------------------------------------------- receipts

-- Private, at most 5 MB per file: a photo, a screenshot, or a PDF.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-receipts', 'store-receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update
set
	name = excluded.name,
	public = false,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

-- True when object_name is <receipt token>/<name>.<jpg|png|webp|heic|pdf>
-- and that token belongs to an order still waiting for payment. Public, so
-- the bucket's rule can call it for a visitor; it says nothing but yes or
-- no about an unguessable token.
create or replace function public.receipt_upload_open(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	token text := split_part(object_name, '/', 1);
begin
	if object_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp|heic|pdf)$' then
		return false;
	end if;

	return exists (
		select 1
		from public.store_orders o
		where o.receipt_token = token::uuid and o.status = 'pending' and o.reserved_until > now()
	);
end;
$$;

-- Records an uploaded receipt on its order. path is the file's name in the
-- bucket, under the token. Returns {code, receipt_at}.
create or replace function public.attach_receipt(token uuid, path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	o public.store_orders%rowtype;
begin
	if path is null or split_part(path, '/', 1) <> token::text or not public.receipt_upload_open(path) then
		raise exception 'This receipt cannot be attached.' using errcode = '22023';
	end if;

	if not exists (select 1 from storage.objects where bucket_id = 'store-receipts' and name = path) then
		raise exception 'The file has not arrived.' using errcode = 'P0002';
	end if;

	update public.store_orders
	set receipt_path = path, receipt_at = now()
	where receipt_token = token
	returning * into o;

	return jsonb_build_object('code', o.code, 'receipt_at', o.receipt_at);
end;
$$;

-- My orders, without an account (Eric, 2026-11-24): a buyer's browser keeps
-- the receipt token of each order it placed, and a private link carries one
-- to another device. For each token asked about, the order's code, status,
-- total, times, and cards, as a JSON array; an unknown token is left out.
-- The token is unguessable, so this shows an order to its buyer only.
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
			) order by l.set_name, l.number, l.name), '[]')
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

-- Storage keeps its files as rows of storage.objects. A visitor may add a
-- file under an open order's token, and never read, replace, or delete one;
-- the owner reads them all, and deletes them when cleaning up.
drop policy if exists "store-receipts: buyer adds" on storage.objects;
drop policy if exists "store-receipts: owner reads" on storage.objects;
drop policy if exists "store-receipts: owner deletes" on storage.objects;

create policy "store-receipts: buyer adds" on storage.objects
	for insert to anon, authenticated
	with check (bucket_id = 'store-receipts' and public.receipt_upload_open(name));

create policy "store-receipts: owner reads" on storage.objects
	for select to authenticated
	using (bucket_id = 'store-receipts' and private.is_store_owner());

create policy "store-receipts: owner deletes" on storage.objects
	for delete to authenticated
	using (bucket_id = 'store-receipts' and private.is_store_owner());

-- ------------------------------------------------------- the owner's calls

-- The orders the Shop screen shows its owner: every order waiting for
-- payment and every paid one not handed over yet, oldest first, each with
-- its cards. Expired orders let their cards go first. A JSON array of
-- {id, code, name, phone, note, total, status, created_at, reserved_until,
-- paid_at, receipt_path, receipt_at, items: [{listing_id, price_brl, name,
-- set_name, number, language, condition, finish}]}.
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
			) order by l.set_name, l.number, l.name), '[]')
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
revoke all on function public.receipt_upload_open(text) from public;
revoke all on function public.attach_receipt(uuid, text) from public;
revoke all on function public.order_status(uuid[]) from public;
revoke all on function public.store_orders_open() from public, anon;
revoke all on function public.mark_paid(text) from public, anon;
revoke all on function public.mark_delivered(text) from public, anon;
revoke all on function public.cancel_order(text) from public, anon;

grant execute on function public.store_catalog() to anon, authenticated;
grant execute on function public.listing_status(text[]) to anon, authenticated;
grant execute on function public.place_order(text[], text, text, text) to anon, authenticated;
grant execute on function public.receipt_upload_open(text) to anon, authenticated;
grant execute on function public.attach_receipt(uuid, text) to anon, authenticated;
grant execute on function public.order_status(uuid[]) to anon, authenticated;
grant execute on function public.store_orders_open() to authenticated;
grant execute on function public.mark_paid(text) to authenticated;
grant execute on function public.mark_delivered(text) to authenticated;
grant execute on function public.cancel_order(text) to authenticated;
