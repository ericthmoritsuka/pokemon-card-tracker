-- Card Tracker: delete a consigned card or a consignor for good (Eric,
-- 2026-11-26: "I need to be able to delete consignments too. I created one
-- and cannot delete it.").
--
-- Return to owner and Remove keep a record: a returned card stays in its
-- consignor's statement, and a removed consignor stays under Show removed
-- consignors. These two calls are for an entry made by mistake or as a
-- test, and they erase it. They refuse anything with a history worth
-- keeping:
--   - delete_consigned: a card that is for sale or returned and was never
--     in an order (no store_order_items row, no payout, no kit). A card
--     that was ever ordered, even in an order that lapsed, keeps its row,
--     because the order still names it.
--   - delete_consignor: a consignor with no consigned card and no payout
--     at all. Delete their cards first.
--
-- The picture: a consigned card's picture is the shared TCGdex one under
-- tcgdex/ in the store bucket, which the owner's own singles of the same
-- print use too, so it stays. Only a picture under consigned/ (this card's
-- own) is this card's alone; delete_consigned returns image_path and the
-- Shop deletes that file after the row is gone (js/shop-consignment.js).
--
-- HOTARU reads store_catalog live, so a deleted card leaves the site on the
-- next page load. A cart that still holds it gets it back as unavailable
-- from place_order, as for a card sold to someone else. store_featured
-- points at card groups, not at a listing, so nothing there names it.
--
-- Run it after supabase/store-consignment.sql. Where: Supabase dashboard,
-- SQL Editor, New query. Paste this whole file and click Run. Running it
-- again is safe: it only defines the two functions.
--
-- To check it worked: Database, Functions lists delete_consigned and
-- delete_consignor.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_consignments') is null then
		raise exception 'Run supabase/store-consignment.sql first: this script deletes its rows.';
	end if;
end;
$$;

-- ----------------------------------------------------------- owner calls

-- Deletes a consigned card that was never ordered. Returns {id, image_path}.
create or replace function public.delete_consigned(listing_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	current_status text;
	picture text;
	order_code text;
begin
	perform private.require_store_owner();

	select l.status, l.image_path into current_status, picture
	from public.store_listings l
	where l.id = delete_consigned.listing_id and l.kind = 'consigned'
	for update;

	if not found then
		raise exception 'No consigned card %.', delete_consigned.listing_id using errcode = 'P0002';
	end if;

	if current_status not in ('available', 'withdrawn') then
		raise exception 'This card is %, so it cannot be deleted.', current_status using errcode = '22023';
	end if;

	select o.code into order_code
	from public.store_order_items i
	join public.store_orders o on o.id = i.order_id
	where i.listing_id = delete_consigned.listing_id
	order by o.created_at desc
	limit 1;

	if order_code is not null then
		raise exception 'This card was in order %, so it stays in the records. Use Return to owner instead.', order_code using errcode = '22023';
	end if;

	if exists (select 1 from public.store_payouts p where p.listing_id = delete_consigned.listing_id) then
		raise exception 'This card has a payout, so it stays in the records.' using errcode = '22023';
	end if;

	if exists (select 1 from public.store_bundle_items b where b.listing_id = delete_consigned.listing_id) then
		raise exception 'This card is in a kit. Take it out of the kit first.' using errcode = '22023';
	end if;

	delete from public.store_consignments c where c.listing_id = delete_consigned.listing_id;
	delete from public.store_listings l where l.id = delete_consigned.listing_id;

	return jsonb_build_object('id', delete_consigned.listing_id, 'image_path', picture);
end;
$$;

-- Deletes a consignor with no cards and no payouts. Returns {id}.
create or replace function public.delete_consignor(consignor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform private.require_store_owner();

	perform 1 from public.store_consignors c where c.id = delete_consignor.consignor_id for update;

	if not found then
		raise exception 'No consignor %.', delete_consignor.consignor_id using errcode = 'P0002';
	end if;

	if exists (select 1 from public.store_consignments x where x.consignor_id = delete_consignor.consignor_id)
		or exists (select 1 from public.store_payouts p where p.consignor_id = delete_consignor.consignor_id) then
		raise exception 'This consignor still has cards in their statement. Delete those cards first, or use Remove.' using errcode = '22023';
	end if;

	delete from public.store_consignors c where c.id = delete_consignor.consignor_id;

	return jsonb_build_object('id', delete_consignor.consignor_id);
end;
$$;

-- ------------------------------------------------------------------ grants

-- Supabase grants new functions to anon by default, so each grant is
-- revoked first.
revoke all on function public.delete_consigned(text) from public, anon;
revoke all on function public.delete_consignor(uuid) from public, anon;

grant execute on function public.delete_consigned(text) to authenticated;
grant execute on function public.delete_consignor(uuid) to authenticated;
