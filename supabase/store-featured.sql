-- Card Tracker: the featured items ("Destaques") of the HOTARU shop.
--
-- What it does: keeps the short, ordered list of what Eric chooses to show
-- first on HOTARU: single cards, whole sets (coleções), and sealed products.
-- Eric edits the list on HOTARU's admin page (save_featured); the home page,
-- the Cartas avulsas page, and the Selados page read it (store_featured) and
-- put those items at the top, in his order.
--
-- Run it after supabase/store.sql, supabase/store-orders.sql, and
-- supabase/store-sealed.sql. Where: Supabase dashboard, SQL Editor, New
-- query. Paste this whole file and click Run. Running it again is safe.
--
-- To check it worked: Table Editor lists store_featured; Database, Functions
-- lists save_featured and store_featured.
--
-- The list only points at things; it sells nothing by itself. A featured card
-- or set with nothing for sale, or a product with no unit left, is skipped by
-- the pages and comes back on its own when it is for sale again.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_products') is null then
		raise exception 'Run supabase/store-sealed.sql first: this script points at its products.';
	end if;
end;
$$;

-- ------------------------------------------------------------------- table

create table if not exists public.store_featured (
	id uuid primary key default gen_random_uuid(),
	-- card: one listing group, as HOTARU groups the catalog (card_id +
	-- language + finish). set: every card of set_name. product: a sealed
	-- product.
	kind text not null check (kind in ('card', 'set', 'product')),
	card_id text check (card_id is null or char_length(card_id) <= 64),
	language text not null default '' check (char_length(language) <= 16),
	-- The finish exactly as store_listings has it ('' for none).
	finish text not null default '' check (char_length(finish) <= 80),
	set_name text check (set_name is null or char_length(set_name) <= 160),
	product_id uuid references public.store_products (id) on delete cascade,
	position int not null check (position between 1 and 60),
	created_at timestamptz not null default now(),
	check (
		(kind = 'card' and card_id is not null and set_name is null and product_id is null)
		or (kind = 'set' and set_name is not null and card_id is null and product_id is null)
		or (kind = 'product' and product_id is not null and card_id is null and set_name is null)
	)
);

alter table public.store_featured enable row level security;

revoke all on public.store_featured from anon;
revoke insert, update, delete on public.store_featured from authenticated;

drop policy if exists "store_featured: owner reads" on public.store_featured;

create policy "store_featured: owner reads" on public.store_featured
	for select to authenticated
	using (private.is_store_owner());

-- ----------------------------------------------------------- public call

-- The featured items in Eric's order: [{kind, card_id, language, finish,
-- set_name, product_id}]. The pages match them against store_catalog and
-- store_sealed.
create or replace function public.store_featured()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'card_id', f.card_id,
		'finish', f.finish,
		'kind', f.kind,
		'language', f.language,
		'product_id', f.product_id,
		'set_name', f.set_name
	) order by f.position), '[]')
	from public.store_featured f;
$$;

-- ------------------------------------------------------------- owner call

-- Replaces the whole list with items, in the order given (at most 60).
-- items: [{kind: 'card', card_id, language, finish} | {kind: 'set',
-- set_name} | {kind: 'product', product_id}]. A repeated item keeps its
-- first place. Returns the list as store_featured gives it.
create or replace function public.save_featured(items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	item jsonb;
	n int := 0;
	item_kind text;
	clean_card text;
	clean_language text;
	clean_finish text;
	clean_set text;
	clean_product uuid;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	if items is null or jsonb_typeof(items) <> 'array' then
		raise exception 'Send a list of items.' using errcode = '22023';
	end if;

	if jsonb_array_length(items) > 60 then
		raise exception 'At most 60 featured items.' using errcode = '22023';
	end if;

	delete from public.store_featured where true;

	for item in select value from jsonb_array_elements(items) with ordinality as e(value, i) order by i loop
		item_kind := item->>'kind';
		clean_card := nullif(btrim(coalesce(item->>'card_id', '')), '');
		clean_language := btrim(coalesce(item->>'language', ''));
		clean_finish := btrim(coalesce(item->>'finish', ''));
		clean_set := nullif(btrim(coalesce(item->>'set_name', '')), '');
		clean_product := nullif(item->>'product_id', '')::uuid;

		if item_kind = 'card' then
			if clean_card is null then
				raise exception 'A featured card needs its card_id.' using errcode = '22023';
			end if;

			if exists (select 1 from public.store_featured f where f.kind = 'card' and f.card_id = clean_card and f.language = clean_language and f.finish = clean_finish) then
				continue;
			end if;

			n := n + 1;
			insert into public.store_featured (kind, card_id, language, finish, position)
			values ('card', clean_card, clean_language, clean_finish, n);
		elsif item_kind = 'set' then
			if clean_set is null then
				raise exception 'A featured set needs its set_name.' using errcode = '22023';
			end if;

			if exists (select 1 from public.store_featured f where f.kind = 'set' and f.set_name = clean_set) then
				continue;
			end if;

			n := n + 1;
			insert into public.store_featured (kind, set_name, position)
			values ('set', clean_set, n);
		elsif item_kind = 'product' then
			if clean_product is null or not exists (select 1 from public.store_products p where p.id = clean_product) then
				raise exception 'A featured product must be one of the shop''s products.' using errcode = '22023';
			end if;

			if exists (select 1 from public.store_featured f where f.kind = 'product' and f.product_id = clean_product) then
				continue;
			end if;

			n := n + 1;
			insert into public.store_featured (kind, product_id, position)
			values ('product', clean_product, n);
		else
			raise exception 'An item''s kind is card, set, or product.' using errcode = '22023';
		end if;
	end loop;

	return public.store_featured();
end;
$$;

revoke all on function public.store_featured() from public;
revoke all on function public.save_featured(jsonb) from public, anon;

grant execute on function public.store_featured() to anon, authenticated;
grant execute on function public.save_featured(jsonb) to authenticated;
