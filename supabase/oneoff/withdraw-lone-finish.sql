-- One-off, 2026-11-26: take off HOTARU the cards that are Eric's only copy
-- of their finish (a lone reverse holo beside normals), which the old spare
-- rule listed. Run it ONCE in the Supabase SQL Editor (it runs as the owner
-- of the tables, so it can read the card document).
--
-- What it does: for each finish of each card in each language (variant ID,
-- else the monprice word, else none), when every live copy of that finish is
-- on HOTARU (available or reserved) and none was marked For sale by hand,
-- one copy is one too many and must stay home. An available copy is
-- withdrawn (the one added first); when every copy of it is reserved, it is
-- only reported, because an open order holds it: cancel that order in the
-- Shop if you want the card.
-- Favorite cards are skipped (only copies marked For sale are listed there).
--
-- IMPORTANT: until v122 is live, opening the Shop publishes the old rule's
-- set again and puts these back. Do not open the Shop before v122.
--
-- The result lists every card it touched, with what it did.

with listed as (
	select l.id, l.status, l.name, l.set_name, l.number, l.language, l.finish, l.price_brl
	from public.store_listings l
	where l.kind = 'single' and l.status in ('available', 'reserved')
),
docs as (
	select d.user_id, d.doc
	from public.documents d
	where exists (
		select 1
		from jsonb_array_elements(coalesce(d.doc -> 'cards', '[]'::jsonb)) c
		join listed on listed.id = c ->> 'id'
	)
),
copies as (
	select
		docs.user_id,
		c ->> 'id' as id,
		coalesce(nullif(c ->> 'catalog', ''), 'international') as catalog,
		c ->> 'card_id' as card_id,
		coalesce(c ->> 'language', '') as lang,
		coalesce('v:' || nullif(c ->> 'variant_id', ''), 'raw:' || nullif(c ->> 'finish_raw', ''), '') as finish_key,
		coalesce(c ->> 'created_at', '') as created_at,
		coalesce(c ->> 'for_sale', '') = 'true' as for_sale,
		coalesce(c ->> 'is_favorite', '') = 'true' as is_favorite
	from docs, jsonb_array_elements(coalesce(docs.doc -> 'cards', '[]'::jsonb)) c
	where coalesce(c ->> 'deleted_at', '') = ''
),
favorites as (
	select distinct user_id, catalog, card_id from copies where is_favorite
),
groups as (
	select c.user_id, c.catalog, c.card_id, c.lang, c.finish_key,
		count(*) as copies, count(listed.id) as on_hotaru, bool_or(c.for_sale) as marked
	from copies c
	left join listed on listed.id = c.id
	where not exists (select 1 from favorites f where f.user_id = c.user_id and f.catalog = c.catalog and f.card_id = c.card_id)
	group by c.user_id, c.catalog, c.card_id, c.lang, c.finish_key
),
keepers as (
	select c.id, g.copies
	from groups g
	join lateral (
		select c.id
		from copies c
		join listed on listed.id = c.id
		where c.user_id = g.user_id and c.catalog = g.catalog and c.card_id = g.card_id and c.lang = g.lang and c.finish_key = g.finish_key
		order by (listed.status = 'available') desc, c.created_at, c.id
		limit 1
	) c on true
	where g.copies = g.on_hotaru and not g.marked
),
withdrawn as (
	update public.store_listings l
	set status = 'withdrawn', updated_at = now()
	from keepers k
	where l.id = k.id and l.kind = 'single' and l.status = 'available'
	returning l.id
)
select
	case when w.id is not null then 'withdrawn' else 'RESERVED by order ' || coalesce(o.code, '?') || ': cancel it in the Shop to keep the card' end as action,
	listed.name, listed.set_name, listed.number, listed.language, listed.finish, listed.price_brl, k.copies as copies_of_this_finish
from keepers k
join listed on listed.id = k.id
left join withdrawn w on w.id = k.id
left join lateral (
	select o.code
	from public.store_order_items oi
	join public.store_orders o on o.id = oi.order_id
	where oi.listing_id = k.id and o.status = 'pending'
	limit 1
) o on true
order by action desc, listed.set_name, listed.number;
