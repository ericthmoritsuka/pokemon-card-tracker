-- Card Tracker: hardening for the HOTARU shop (principal engineer review of
-- HOTARU at 042d50f, findings H1, H2, H3, M4, M5, and M6).
--
-- What it does: bounds what an anonymous visitor can reserve (H1), makes
-- order codes that never truncate or collide and stops failed orders from
-- using up numbers (H2), lets the sealed admin form send the quantity it
-- loaded so a stale save cannot bring back sold or reserved units (H3), keeps
-- an order with a receipt from expiring under the buyer (M4), caps receipt
-- uploads per order (M5), refuses to let an older store script run over
-- these fixes without saying so (M6), and makes store_sync skip a copy that
-- breaks the listing invariant (missing, in a binder, or the last of its
-- finish) instead of publishing it.
--
-- Run it LAST, after every other store script (store.sql, store-orders.sql,
-- store-sealed.sql, store-withdraw.sql, store-own-pictures.sql,
-- store-featured.sql, store-blog.sql, store-bundles.sql,
-- store-consignment.sql, store-order-stages.sql, and
-- store-consignment-delete.sql). Where: Supabase dashboard, SQL Editor, New
-- query. Paste this whole file and click Run. Running it again is safe.
--
-- To check it worked: the run ends with one row, "store ok". Later, at any
-- time, `select private.store_verify();` gives the same row, or an error
-- naming what an older script undid.
--
-- Each function below starts from its live definition (the file named in
-- its comment) and keeps everything that one does: kits, consigned cards,
-- image paths, and the 48-hour hold HOTARU's pages promise.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regprocedure('public.place_order(text[],text,text,text,uuid[])') is null
		or to_regclass('public.store_payouts') is null
		or not exists (select 1 from pg_proc where proname = 'store_order_checks')
	then
		raise exception 'Run every other store script first (store-bundles.sql, store-consignment.sql, and store-order-stages.sql at least): this script replaces their functions.';
	end if;
end;
$$;

-- ------------------------------------------------------------------- M6

-- M6: "whichever script ran last wins". This marker tells every older
-- store script that redefines a function this file replaces (store.sql,
-- store-orders.sql, store-sealed.sql, store-own-pictures.sql, and
-- store-bundles.sql) to refuse to run, unless Eric types
-- `set store.allow_rerun = on;` above it on purpose. Bump the number when
-- this file changes what it replaces. Version 2 adds store_sync (store.sql),
-- which now checks the listing invariant. Version 3 (v128 review H1, H2)
-- counts copies in open orders as leaving and replaces store_sync(jsonb)
-- with store_sync(jsonb, boolean), which revives a withdrawn listing only
-- when asked.
create or replace function private.store_hardening_version()
returns int
language sql
immutable
set search_path = ''
as $$
	select 3;
$$;

revoke all on function private.store_hardening_version() from public, anon, authenticated;

-- ---------------------------------------------------------------- limits

-- H1, M5: every limit in one place, so Eric can change a number by editing
-- this function and running the file again.
--   orders_per_phone    pending orders one phone (digits and letters only,
--                       lowercased) may hold
--   orders_per_client   pending orders one client (a salted hash of the
--                       first x-forwarded-for address) may hold
--   reserved_cards      cards all pending orders together may hold
--   receipts_per_order  files the receipts bucket takes under one order
create or replace function private.store_limit(name text)
returns int
language sql
immutable
set search_path = ''
as $$
	select case name
		when 'orders_per_phone' then 2
		when 'orders_per_client' then 2
		when 'reserved_cards' then 60
		when 'receipts_per_order' then 3
	end;
$$;

revoke all on function private.store_limit(text) from public, anon, authenticated;

-- H1: a random salt made once, so a client key cannot be turned back into
-- an IP address by hashing every address.
create table if not exists private.store_secret (
	one boolean primary key default true check (one),
	salt text not null default gen_random_uuid()::text
);

insert into private.store_secret (one) values (true) on conflict (one) do nothing;

revoke all on private.store_secret from public, anon, authenticated;

-- H1: who is ordering, without storing who it is. The phone key strips
-- everything but letters and digits ("(81) 9 9999-0000" and "81999990000"
-- are one buyer; HOTARU also takes a ramal, so letters stay). The client
-- key is null when PostgREST passes no address, as in the SQL Editor.
alter table public.store_orders add column if not exists phone_key text;
alter table public.store_orders add column if not exists client_key text;

update public.store_orders
set phone_key = lower(regexp_replace(phone, '[^0-9A-Za-z]', '', 'g'))
where phone_key is null;

create index if not exists store_orders_pending_phone on public.store_orders (phone_key) where status = 'pending';
create index if not exists store_orders_pending_client on public.store_orders (client_key) where status = 'pending';

create or replace function private.client_key()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	headers jsonb;
	address text;
begin
	begin
		headers := nullif(current_setting('request.headers', true), '')::jsonb;
	exception
		when others then
			headers := null;
	end;

	address := nullif(btrim(split_part(coalesce(headers->>'x-forwarded-for', ''), ',', 1)), '');

	if address is null then
		return null;
	end if;

	return encode(sha256(convert_to((select s.salt from private.store_secret s) || '/' || address, 'UTF8')), 'hex');
end;
$$;

revoke all on function private.client_key() from public, anon, authenticated;

-- H2: HTR-0001 to HTR-9999 as before, then HTR-10000 and up. lpad cut a
-- longer number down to four digits, so 10000 to 10009 all became HTR-1000.
-- Existing codes keep their numbers; the loop skips any code already taken
-- (a sequence moved by hand), so a code never collides.
create or replace function private.next_order_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
	n bigint;
	new_code text;
begin
	loop
		n := nextval('public.store_order_number');
		new_code := 'HTR-' || lpad(n::text, greatest(4, char_length(n::text)), '0');
		exit when not exists (select 1 from public.store_orders o where o.code = new_code);
	end loop;

	return new_code;
end;
$$;

revoke all on function private.next_order_code() from public, anon, authenticated;

-- ------------------------------------------------------------ place_order

-- From supabase/store-bundles.sql (the live one), same signature, same
-- arguments, same return shape. Three changes:
--   H1: before reserving, it takes a lock so concurrent orders count one at
--       a time, then refuses (22023) when the phone or the client already
--       holds orders_per_phone / orders_per_client pending orders, or when
--       pending orders would hold more than reserved_cards cards. HOTARU
--       shows the message as it shows "An order holds 1 to 20 cards.".
--   H2: the order's ID is made first and the cards are reserved under it
--       (store_listings.order_id has no foreign key). The order row, and so
--       its number, is made only after every card was won, so an order that
--       fails (a card taken, an ID that does not exist) uses no number.
--   H2: the code comes from private.next_order_code().
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
	key_phone text;
	key_client text;
	new_id uuid := gen_random_uuid();
	singles text[];
	kits uuid[];
	kit_cards text[];
	wanted text[];
	got text[];
	order_row public.store_orders%rowtype;
	sum_brl numeric(10, 2);
	held int;
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

	key_phone := lower(regexp_replace(clean_phone, '[^0-9A-Za-z]', '', 'g'));

	if key_phone = '' then
		raise exception 'Type a phone number of up to 40 characters.' using errcode = '22023';
	end if;

	key_client := private.client_key();

	perform private.release_expired();

	-- H1: one order at a time from here to commit, so two calls cannot both
	-- pass the counts below. A shop this size closes a few orders a day.
	perform pg_advisory_xact_lock(hashtext('store:place_order'));

	if (select count(*) from public.store_orders o where o.status = 'pending' and o.phone_key = key_phone) >= private.store_limit('orders_per_phone') then
		raise exception 'This phone already has orders waiting for payment. Pay one of them first.' using errcode = '22023';
	end if;

	if key_client is not null and (select count(*) from public.store_orders o where o.status = 'pending' and o.client_key = key_client) >= private.store_limit('orders_per_client') then
		raise exception 'This connection already has orders waiting for payment. Pay one of them first.' using errcode = '22023';
	end if;

	select count(*) into held
	from public.store_listings l
	join public.store_orders o on o.id = l.order_id
	where l.status = 'reserved' and o.status = 'pending';

	if held + cardinality(wanted) > private.store_limit('reserved_cards') then
		raise exception 'The shop is holding too many unpaid orders right now. Try again later.' using errcode = '22023';
	end if;

	-- A kit that is off or no longer exists is not for sale.
	select coalesce(array_agg(k), '{}') into taken_kits
	from unnest(kits) as k
	where not exists (select 1 from public.store_bundles b where b.id = k and b.active);

	if cardinality(taken_kits) > 0 then
		return jsonb_build_object('unavailable', '[]'::jsonb, 'unavailable_kits', to_jsonb(taken_kits));
	end if;

	begin
		-- The race is settled here: each row is locked as it is changed, and
		-- a second order waiting on it sees it reserved and skips it. The
		-- order row does not exist yet (H2).
		with won as (
			update public.store_listings l
			set status = 'reserved', order_id = new_id, updated_at = now()
			where l.id = any (wanted) and l.status = 'available'
			returning l.id
		)
		select coalesce(array_agg(id), '{}') into got from won;

		if cardinality(got) < cardinality(wanted) then
			select coalesce(array_agg(x), '{}') into taken from unnest(wanted) as x where not (x = any (got));
			select coalesce(array_agg(distinct i.bundle_id), '{}') into taken_kits from public.store_bundle_items i where i.bundle_id = any (kits) and i.listing_id = any (taken);
			raise exception using errcode = 'P0001', message = 'store:taken';
		end if;

		-- Every card won: only now is a number taken (H2).
		insert into public.store_orders (id, code, name, phone, note, total, reserved_until, phone_key, client_key)
		values (new_id, private.next_order_code(), clean_name, clean_phone, clean_note, 0.01, now() + private.store_hold(), key_phone, key_client)
		returning * into order_row;

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
				-- Everything inside the block is undone: no order, nothing
				-- reserved, no number used.
				return jsonb_build_object('unavailable', to_jsonb(taken), 'unavailable_kits', to_jsonb(taken_kits));
			end if;

			raise;
	end;

	return jsonb_build_object('code', order_row.code, 'receipt_token', order_row.receipt_token, 'reserved_until', order_row.reserved_until, 'total', sum_brl);
end;
$$;

revoke all on function public.place_order(text[], text, text, text, uuid[]) from public;
grant execute on function public.place_order(text[], text, text, text, uuid[]) to anon, authenticated;

-- --------------------------------------------------------------- receipts

-- M5: whether an order still takes a receipt, by its token. Split out of
-- receipt_upload_open so attach_receipt can record the file that was the
-- last one allowed.
create or replace function private.receipt_order_open(token uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.store_orders o
		where o.receipt_token = token and o.status = 'pending' and o.reserved_until > now()
	);
$$;

revoke all on function private.receipt_order_open(uuid) from public, anon, authenticated;

-- From supabase/store-orders.sql (the live one). M5: also refuses once
-- receipts_per_order files sit under the token. The bucket's own
-- file_size_limit (5 MB, store-orders.sql) bounds each file, so one order
-- holds at most 15 MB. A Storage policy sees the object's name and bucket
-- only, not its size, so the size cap stays on the bucket. The insert
-- policy calls this before the new row exists, so the count is of the files
-- already there.
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

	if not private.receipt_order_open(token::uuid) then
		return false;
	end if;

	return (
		select count(*)
		from storage.objects s
		where s.bucket_id = 'store-receipts' and s.name like token || '/%'
	) < private.store_limit('receipts_per_order');
end;
$$;

revoke all on function public.receipt_upload_open(text) from public;
grant execute on function public.receipt_upload_open(text) to anon, authenticated;

-- From supabase/store-orders.sql (the live one). Two changes:
--   M5: checks the order with receipt_order_open rather than
--       receipt_upload_open, which says no once the last allowed file is in.
--   M4: a receipt moves the order's deadline to at least 48 hours from now,
--       so a buyer who pays at hour 47 is not expired before Eric looks.
--       It never shortens a deadline.
create or replace function public.attach_receipt(token uuid, path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	o public.store_orders%rowtype;
begin
	if path is null or split_part(path, '/', 1) <> token::text
		or path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp|heic|pdf)$'
		or not private.receipt_order_open(token)
	then
		raise exception 'This receipt cannot be attached.' using errcode = '22023';
	end if;

	if not exists (select 1 from storage.objects where bucket_id = 'store-receipts' and name = path) then
		raise exception 'The file has not arrived.' using errcode = 'P0002';
	end if;

	update public.store_orders
	set receipt_path = path, receipt_at = now(), reserved_until = greatest(reserved_until, now() + private.store_hold())
	where receipt_token = token
	returning * into o;

	return jsonb_build_object('code', o.code, 'receipt_at', o.receipt_at);
end;
$$;

revoke all on function public.attach_receipt(uuid, text) from public;
grant execute on function public.attach_receipt(uuid, text) to anon, authenticated;

-- ------------------------------------------------------------ save_product

-- From supabase/store-sealed.sql (the live one). H3: the admin form loaded
-- product.available when it opened; a buyer may reserve a unit before Eric
-- saves. The form now also sends expected_available, the count it loaded,
-- and the save applies the difference he typed to the units available now:
-- a description edit (quantity = expected_available) leaves the units
-- alone, and "2 to 3" adds one even if one sold meanwhile. Without
-- expected_available (the admin.js before this change) it behaves as
-- before, so either can ship first. Inactive still offers no unit.
create or replace function public.save_product(product jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	pid uuid := coalesce(nullif(product->>'id', '')::uuid, gen_random_uuid());
	clean_name text := btrim(coalesce(product->>'name', ''));
	clean_category text := nullif(btrim(coalesce(product->>'category', '')), '');
	clean_language text := nullif(btrim(coalesce(product->>'language', '')), '');
	clean_description text := nullif(btrim(coalesce(product->>'description', '')), '');
	price numeric(10, 2) := (product->>'price_brl')::numeric(10, 2);
	wanted int := coalesce((product->>'quantity')::int, 0);
	expected int := nullif(product->>'expected_available', '')::int;
	is_active boolean := coalesce((product->>'active')::boolean, true);
	pics text[];
	have int;
	target int;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	if char_length(clean_name) not between 1 and 120 then
		raise exception 'Type a name of up to 120 characters.' using errcode = '22023';
	end if;

	if price is null or price <= 0 then
		raise exception 'Type a price above zero.' using errcode = '22023';
	end if;

	if wanted not between 0 and 99 then
		raise exception 'The quantity is 0 to 99.' using errcode = '22023';
	end if;

	if expected is not null and expected not between 0 and 99 then
		raise exception 'The loaded quantity is 0 to 99.' using errcode = '22023';
	end if;

	select coalesce(array_agg(x order by n), '{}') into pics
	from jsonb_array_elements_text(coalesce(product->'photos', '[]')) with ordinality as e(x, n);

	if cardinality(pics) > 8 then
		raise exception 'At most 8 photos.' using errcode = '22023';
	end if;

	if exists (select 1 from unnest(pics) x where not private.is_store_path(x) or x not like 'sealed/' || pid::text || '/%') then
		raise exception 'A photo is not in this product''s folder.' using errcode = '22023';
	end if;

	insert into public.store_products as p (id, name, category, language, description, price_brl, photos, active)
	values (pid, clean_name, clean_category, clean_language, clean_description, price, pics, is_active)
	on conflict (id) do update
	set name = excluded.name, category = excluded.category, language = excluded.language, description = excluded.description,
		price_brl = excluded.price_brl, photos = excluded.photos, active = excluded.active, updated_at = now();

	-- Lock the product's available units so a buyer's order waits for this
	-- save rather than slipping between the count and the change.
	perform 1 from public.store_listings l where l.kind = 'sealed' and l.card_id = pid::text and l.status = 'available' for update;

	select count(*) into have from public.store_listings l where l.kind = 'sealed' and l.card_id = pid::text and l.status = 'available';

	target := case
		when not is_active then 0
		when expected is null then wanted
		else least(greatest(have + wanted - expected, 0), 99)
	end;

	if have < target then
		insert into public.store_listings (id, kind, card_id, catalog, language, name, set_name, description, image_path, price_brl, status)
		select 'sealed-' || gen_random_uuid()::text, 'sealed', pid::text, 'sealed', clean_language, clean_name, clean_category, clean_description, pics[1], price, 'available'
		from generate_series(1, target - have);
	elsif have > target then
		update public.store_listings
		set status = 'withdrawn', updated_at = now()
		where id in (
			select l.id from public.store_listings l
			where l.kind = 'sealed' and l.card_id = pid::text and l.status = 'available'
			order by l.published_at desc
			limit have - target
		);
	end if;

	-- The units for sale say what the product says now. A reserved or sold
	-- unit keeps what its order was closed with.
	update public.store_listings l
	set name = clean_name, set_name = clean_category, language = clean_language, description = clean_description,
		image_path = pics[1], price_brl = price, updated_at = now()
	where l.kind = 'sealed' and l.card_id = pid::text and l.status = 'available';

	return private.product_row(pid);
end;
$$;

revoke all on function public.save_product(jsonb) from public, anon;
grant execute on function public.save_product(jsonb) to authenticated;

-- ------------------------------------------------------------- store_sync

-- The listing invariant, server half (plans/roadmap.md, "Backlog:
-- preventing wrong listings"; js/listing-invariant.js listingProblems is
-- the client half, Eric 2026-11-26). The client checks before it calls;
-- this repeats the check before the upsert, so a client bug (a lone
-- reverse holo, a copy in a binder) cannot put a card on HOTARU.
--
-- The owner's collection is the caller's row in public.documents
-- (setup.sql; patch_document in patch-document.sql writes the same row):
-- doc -> 'cards' is the copies, doc -> 'binders' the binders. store_sync
-- reads it as saved; the Shop publishes only once the phone has synced.
--
-- A single row is skipped, not upserted, when its copy:
--   missing  is not a live copy in the document (no entry with that id, or
--            the entry has deleted_at), or there is no document at all
--   held     sits in a pocket of a live binder: any entry_id in its slots.
--            Only pockets. A binder made from a list keeps its slots empty
--            and holds copies by claims the app computes (js/binders.js
--            copyClaims: refresh snapshots, picks, allocation order), too
--            much to repeat here, so those are the client's check alone.
--            Every live binder's slots count, even a list binder's stale
--            ones and pockets off the grid, which the app ignores: stricter.
--   last     is the last live copy of its card + language + finish left at
--            home once the earlier rows of this same call leave, the
--            client's batch rule: copies whose listing is reserved or sold
--            (an open order, or a sale whose copy is still in the document)
--            leave first, whether or not this call names them (v128 review
--            H1); then copies marked For sale; then the others in the order
--            sent, and each row passes only while at least one other copy of
--            its key stays home.
-- A copy with for_sale true is exempt from held and last, never from
-- missing, as in the client.
--
-- The key, as js/listing-invariant.js lastKey: catalog (empty is
-- 'international'), card_id, language (empty is ''), and finish:
-- 'v:' || variant_id, else 'raw:' || finish_raw, else '' (unset, its own
-- key, never paired with Normal). Two things the client merges stay apart
-- here: js/wishlist.js copyFinishKey also reads a card's only printing from
-- the phone's catalog, and js/shop.js catalogTwins counts a hand-made copy
-- as the catalog card it matches. The server has neither catalog, so it
-- counts such copies under their own key. Splitting a key only lowers its
-- count, and every key this file keeps home one copy of sits inside a
-- client key, so the server can skip a copy the client would list (a
-- false skip, which Eric sees and fixes) but never lists one the client
-- would not (a false listing). False skips are acceptable; false listings
-- are not.
--
-- Fail closed: a skipped copy is not upserted and, being absent from the
-- call, its available listing is withdrawn, so a kit holding it leaves the
-- catalog too. Rows store_sync never changed are not judged: an id whose
-- listing is reserved, sold, or not a single (sealed, consigned) passes
-- through untouched, as before, though a copy among them still counts as
-- leaving. Kit, sealed, and consignment tables are not touched. A
-- repeated id keeps its first row.
--
-- The answer keeps its shape ({<id>: {status, image_path}}), and gains one
-- key, "_skipped": [{id, reason}], only when a row was skipped
-- (js/store-publish.js syncListings, js/shop-view.js).
--
-- relist (v128 review H2): only true revives a withdrawn listing. With
-- false, a withdrawn row named in the call stays withdrawn, so an automatic
-- sync (opening the Shop, saving a price) can never put a card back on
-- HOTARU; the app sends true only from Publish changes. It has no default
-- on purpose, and the one-argument store_sync(jsonb) is dropped: PostgREST
-- matches a call by its argument names, so a default would let a v127
-- client's call ({listings} alone) reach this function. Without one, a v127
-- client gets PGRST202 and its Shop says "Publishing is not set up for
-- this version yet" (v127's text: "Publishing is not set up yet: run
-- supabase/store.sql") and changes nothing, which fails closed.
create or replace function private.listing_invariant_key(entry jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
	select jsonb_build_array(
		coalesce(nullif(entry ->> 'catalog', ''), 'international'),
		entry ->> 'card_id',
		coalesce(entry ->> 'language', ''),
		case
			when coalesce(entry ->> 'variant_id', '') <> '' then 'v:' || (entry ->> 'variant_id')
			when coalesce(entry ->> 'finish_raw', '') <> '' then 'raw:' || (entry ->> 'finish_raw')
			else ''
		end
	)::text;
$$;

revoke all on function private.listing_invariant_key(jsonb) from public, anon, authenticated;

-- A copy or binder is live while deleted_at is missing, null, or empty
-- (the client's !entry.deleted_at; anything else counts as deleted).
create or replace function private.listing_invariant_live(entry jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select jsonb_typeof(entry) = 'object' and coalesce(entry ->> 'deleted_at', '') in ('', 'false');
$$;

revoke all on function private.listing_invariant_live(jsonb) from public, anon, authenticated;

-- From store.sql's store_sync; the upsert, withdraw, and answer are its own.
drop function if exists public.store_sync(jsonb);

create or replace function public.store_sync(listings jsonb, relist boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	ids text[] := '{}';
	result jsonb;
	doc jsonb;
	cards jsonb;
	live jsonb;
	counts jsonb;
	held text[];
	leaving jsonb := '{}';
	accepted jsonb := '[]';
	skipped jsonb := '[]';
	seen text[] := '{}';
	item jsonb;
	entry jsonb;
	listing_id text;
	k text;
	away text[];
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

	-- listing_invariant: the owner's document, its live copies by id, how
	-- many live copies each key has, and the copies in binder pockets.
	select d.doc into doc from public.documents d where d.user_id = (select auth.uid());
	cards := case when jsonb_typeof(doc -> 'cards') = 'array' then doc -> 'cards' else '[]' end;

	select coalesce(jsonb_object_agg(c.value ->> 'id', c.value), '{}')
	into live
	from jsonb_array_elements(cards) c
	where private.listing_invariant_live(c.value) and coalesce(c.value ->> 'id', '') <> '';

	select coalesce(jsonb_object_agg(x.k, x.n), '{}')
	into counts
	from (
		select private.listing_invariant_key(c.value) as k, count(*) as n
		from jsonb_array_elements(cards) c
		where private.listing_invariant_live(c.value) and coalesce(c.value ->> 'id', '') <> ''
		group by 1
	) x;

	select coalesce(array_agg(distinct s.value ->> 'entry_id'), '{}')
	into held
	from jsonb_array_elements(case when jsonb_typeof(doc -> 'binders') = 'array' then doc -> 'binders' else '[]' end) b
	cross join lateral jsonb_array_elements(case when jsonb_typeof(b.value -> 'slots') = 'array' then b.value -> 'slots' else '[]' end) s
	where private.listing_invariant_live(b.value) and coalesce(s.value ->> 'entry_id', '') <> '';

	-- Copies in an open order, or sold and still in the document, leave
	-- first, named in this call or not (v128 review H1).
	select coalesce(array_agg(l.id), '{}')
	into away
	from public.store_listings l
	where l.kind = 'single' and l.status in ('reserved', 'sold') and live ? l.id;

	foreach listing_id in array away loop
		k := private.listing_invariant_key(live -> listing_id);
		leaving := jsonb_set(leaving, array[k], to_jsonb(coalesce((leaving ->> k)::int, 0) + 1));
	end loop;

	-- Then copies marked For sale (Eric's consent).
	for item in select e.value from jsonb_array_elements(listings) e loop
		listing_id := item ->> 'id';

		if listing_id is null or listing_id = any (seen) then
			continue;
		end if;

		seen := seen || listing_id;
		entry := live -> listing_id;

		if entry is not null and entry -> 'for_sale' = 'true'::jsonb and not (listing_id = any (away)) then
			k := private.listing_invariant_key(entry);
			leaving := jsonb_set(leaving, array[k], to_jsonb(coalesce((leaving ->> k)::int, 0) + 1));
		end if;
	end loop;

	seen := '{}';

	for item in select e.value from jsonb_array_elements(listings) e loop
		listing_id := item ->> 'id';

		if listing_id is null then
			skipped := skipped || jsonb_build_object('id', null, 'reason', 'missing');

			continue;
		end if;

		if listing_id = any (seen) then
			continue;
		end if;

		seen := seen || listing_id;
		entry := live -> listing_id;

		-- A row store_sync never changes passes through untouched.
		if exists (
			select 1 from public.store_listings l
			where l.id = listing_id and (l.kind <> 'single' or l.status not in ('available', 'withdrawn'))
		) then
			if entry is not null and entry -> 'for_sale' is distinct from 'true'::jsonb and not (listing_id = any (away)) then
				k := private.listing_invariant_key(entry);
				leaving := jsonb_set(leaving, array[k], to_jsonb(coalesce((leaving ->> k)::int, 0) + 1));
			end if;

			accepted := accepted || item;

			continue;
		end if;

		if entry is null then
			skipped := skipped || jsonb_build_object('id', listing_id, 'reason', 'missing');

			continue;
		end if;

		if entry -> 'for_sale' = 'true'::jsonb then
			accepted := accepted || item;

			continue;
		end if;

		if listing_id = any (held) then
			skipped := skipped || jsonb_build_object('id', listing_id, 'reason', 'held');

			continue;
		end if;

		k := private.listing_invariant_key(entry);

		if coalesce((leaving ->> k)::int, 0) + 1 >= coalesce((counts ->> k)::int, 0) then
			skipped := skipped || jsonb_build_object('id', listing_id, 'reason', 'last');

			continue;
		end if;

		leaving := jsonb_set(leaving, array[k], to_jsonb(coalesce((leaving ->> k)::int, 0) + 1));
		accepted := accepted || item;
	end loop;

	select coalesce(array_agg(e.value ->> 'id'), '{}') into ids from jsonb_array_elements(accepted) as e(value);

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
	from jsonb_array_elements(accepted) as e(value)
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
	where l.kind = 'single' and (l.status = 'available' or (l.status = 'withdrawn' and relist is true));

	update public.store_listings l
	set status = 'withdrawn', updated_at = now()
	where l.kind = 'single' and l.status = 'available' and not (l.id = any (ids));

	select coalesce(jsonb_object_agg(l.id, jsonb_build_object('image_path', l.image_path, 'status', l.status)), '{}')
	into result
	from public.store_listings l
	where l.id = any (ids);

	if jsonb_array_length(skipped) > 0 then
		result := result || jsonb_build_object('_skipped', skipped);
	end if;

	return result;
end;
$$;

revoke all on function public.store_sync(jsonb, boolean) from public, anon;
grant execute on function public.store_sync(jsonb, boolean) to authenticated;

-- ------------------------------------------------------------- M6 verify

-- M6: says whether the live functions are the ones the store needs, or
-- names each one an older script put back. The check is by what each body
-- does (a word only the newest version uses), since an older script keeps
-- the same names. Run `select private.store_verify();` any time.
create or replace function private.store_verify()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	missing text[] := '{}';
	body text;
begin
	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.place_order(text[],text,text,text,uuid[])'));
	if body is null or body not like '%store_limit%' or body not like '%next_order_code%' then
		missing := array_append(missing, 'place_order (store-bundles.sql, then store-hardening.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.store_catalog()'));
	if body is null or body not like '%in_kit%' then
		missing := array_append(missing, 'store_catalog (store-bundles.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.mark_paid(text)'));
	if body is null or body not like '%store_payouts%' then
		missing := array_append(missing, 'mark_paid (store-consignment.sql)');
	end if;

	if to_regprocedure('private.is_store_path(text)') is null
		or not private.is_store_path('own/x.jpg')
		or not private.is_store_path('consigned/cons-00000000-0000-0000-0000-000000000000.jpg')
	then
		missing := array_append(missing, 'is_store_path (store-consignment.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.save_product(jsonb)'));
	if body is null or body not like '%expected_available%' then
		missing := array_append(missing, 'save_product (store-hardening.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.receipt_upload_open(text)'));
	if body is null or body not like '%receipts_per_order%' then
		missing := array_append(missing, 'receipt_upload_open (store-hardening.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.attach_receipt(uuid,text)'));
	if body is null or body not like '%store_hold%' then
		missing := array_append(missing, 'attach_receipt (store-hardening.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.order_status(uuid[])'));
	if body is null or body not like '%bundle_name%' then
		missing := array_append(missing, 'order_status (store-bundles.sql)');
	end if;

	body := (select pg_get_functiondef(p.oid) from pg_proc p where p.oid = to_regprocedure('public.store_sync(jsonb,boolean)'));
	if body is null or body not like '%listing_invariant%' or body not like '%relist is true%'
		or to_regprocedure('public.store_sync(jsonb)') is not null
	then
		missing := array_append(missing, 'store_sync (store-hardening.sql)');
	end if;

	if cardinality(missing) > 0 then
		raise exception 'An older store script replaced: %. Run the named scripts again, in the order in DESIGN.md, then store-hardening.sql.', array_to_string(missing, '; ');
	end if;

	return 'store ok';
end;
$$;

revoke all on function private.store_verify() from public, anon, authenticated;

select private.store_verify();
