-- Card Tracker: take a favorite card off HOTARU the moment it is starred
-- (Eric, 2026-11-24: a favorite is a card he does not trade or sell for
-- anything, and no order may arrive for one).
--
-- What it does: adds store_withdraw, the owner's call that withdraws the
-- listings of the copies named, and nothing else. The Shop's store_sync
-- (supabase/store.sql) also withdraws every single that is no longer a
-- spare, but it takes the whole set of listings, which only the Shop screen
-- works out; the card page names just the copies it starred.
--
-- Run it after supabase/store.sql. Where: Supabase dashboard, SQL Editor,
-- New query. Paste this whole file and click Run. Running it again is safe:
-- the function is replaced.
--
-- To check it worked: Database, Functions lists store_withdraw.
--
-- Who can do what: only the owner of the family group (store.sql's
-- private.is_store_owner) withdraws. Only a single that is available is
-- withdrawn: a reserved or sold listing is never touched, so an order
-- already placed still completes, and a sealed product's units are left to
-- save_product (supabase/store-sealed.sql).

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_listings') is null then
		raise exception 'Run supabase/store.sql first: this script withdraws its listings.';
	end if;
end;
$$;

-- --------------------------------------------------------------- function

-- Withdraws the available singles among ids, the copies' IDs, as store_sync
-- withdraws a copy that is no longer a spare: the listing stays, withdrawn,
-- and a later store_sync that names it makes it available again (a star
-- taken off, then Publish). Returns the IDs it withdrew; an ID that is not
-- listed, or not available, is left out.
create or replace function public.store_withdraw(ids text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
	withdrawn text[];
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can withdraw.' using errcode = '42501';
	end if;

	if ids is null then
		raise exception 'ids must be an array.' using errcode = '22023';
	end if;

	if cardinality(ids) > 2000 then
		raise exception 'At most 2,000 listings at once.' using errcode = '22023';
	end if;

	with changed as (
		update public.store_listings l
		set status = 'withdrawn', updated_at = now()
		where l.kind = 'single' and l.status = 'available' and l.id = any (ids)
		returning l.id
	)
	select coalesce(array_agg(id order by id), '{}') into withdrawn from changed;

	return withdrawn;
end;
$$;

-- Supabase grants new functions to anon by default, so each grant is
-- spelled out.
revoke all on function public.store_withdraw(text[]) from public, anon;
grant execute on function public.store_withdraw(text[]) to authenticated;
