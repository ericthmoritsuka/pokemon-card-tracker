-- HOTARU listings with the owner's own picture (Eric, 2026-11-24): a card
-- the catalog has no picture for (a hand-made card, a print TCGdex has none
-- for) is listed with the owner's photo of it, copied into the public store
-- bucket as own/<photo id>.webp or .jpg (js/shop.js ownPicturePath,
-- js/store-publish.js uploadOwnPicture).
--
-- Run once in the Supabase SQL Editor, after store.sql and store-sealed.sql.
-- Safe to run again. Until it runs, such a card is still published, only
-- without a picture, and the Shop says how many cards have none.
--
-- The store bucket's path rule, as store-sealed.sql leaves it, widened to
-- own/<photo id>.webp or .jpg. The bucket's policies (store.sql) call this
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
		or object_name ~ '^own/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$';
$$;

revoke all on function private.is_store_path(text) from public, anon;
grant execute on function private.is_store_path(text) to authenticated;
