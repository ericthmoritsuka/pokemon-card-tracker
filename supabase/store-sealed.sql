-- Card Tracker: sealed products for the HOTARU shop (plans/hotaru-catalog-
-- plan.md, step 4).
--
-- What it does: creates the sealed products Eric adds on HOTARU's admin page
-- (name, kind of product, language, description, price, photos, and how many
-- are for sale), the owner's calls that save and list them, and the one
-- public call HOTARU's Selados page reads (store_sealed). It also lets the
-- public store bucket take a product's photos, and gives the order calls
-- each item's kind, so the Shop screen tells a sealed product from a card.
--
-- Run it after supabase/store.sql and supabase/store-orders.sql. Where:
-- Supabase dashboard, SQL Editor, New query. Paste this whole file and
-- click Run. Running it again is safe.
--
-- To check it worked: Table Editor lists store_products; Database,
-- Functions lists save_product, store_products_admin, and store_sealed.
--
-- How a product is sold: each unit is one row of store_listings with kind
-- sealed and the product's ID as its card_id, so the cart, the reservation
-- for whoever closes first, the 48 hours to pay, Pix, receipts, and the
-- Shop's orders work for it exactly as for a card. The quantity Eric types
-- is how many units are for sale now: saving adds units or withdraws
-- available ones, and never touches a reserved or sold one.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regclass('public.store_orders') is null then
		raise exception 'Run supabase/store-orders.sql first: this script uses its orders.';
	end if;
end;
$$;

-- ------------------------------------------------------------------- table

create table if not exists public.store_products (
	id uuid primary key default gen_random_uuid(),
	name text not null check (char_length(name) between 1 and 120),
	-- Booster, Booster box, ETB, and so on, as Eric types it.
	category text check (category is null or char_length(category) <= 40),
	language text check (language is null or char_length(language) <= 16),
	description text check (description is null or char_length(description) <= 2000),
	price_brl numeric(10, 2) not null check (price_brl > 0),
	-- Paths in the public store bucket, the first one the cover.
	photos text[] not null default '{}' check (cardinality(photos) <= 8),
	active boolean not null default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

alter table public.store_products enable row level security;

revoke all on public.store_products from anon;
revoke insert, update, delete on public.store_products from authenticated;

drop policy if exists "store_products: owner reads" on public.store_products;

create policy "store_products: owner reads" on public.store_products
	for select to authenticated
	using (private.is_store_owner());

-- ------------------------------------------------------------------ photos

-- The store bucket's path rule (supabase/store.sql), widened to a product's
-- photos: sealed/<product id>/<name>.webp, .jpg, or .png.
create or replace function private.is_store_path(object_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select object_name ~ '^tcgdex/[a-z]{2}(-[a-z]{2})?/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.(webp|png)$'
		or object_name ~ '^sealed/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$'
		or object_name ~ '^sealed/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(webp|jpg|png)$';
$$;

-- ------------------------------------------------------------------ helpers

-- A product with its units counted, for the admin page.
create or replace function private.product_row(product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'active', p.active,
		'available', (select count(*) from public.store_listings l where l.kind = 'sealed' and l.card_id = p.id::text and l.status = 'available'),
		'category', p.category,
		'created_at', p.created_at,
		'description', p.description,
		'id', p.id,
		'language', p.language,
		'name', p.name,
		'photos', to_jsonb(p.photos),
		'price_brl', p.price_brl,
		'reserved', (select count(*) from public.store_listings l where l.kind = 'sealed' and l.card_id = p.id::text and l.status = 'reserved'),
		'sold', (select count(*) from public.store_listings l where l.kind = 'sealed' and l.card_id = p.id::text and l.status = 'sold'),
		'updated_at', p.updated_at
	)
	from public.store_products p
	where p.id = product_id;
$$;

revoke all on function private.product_row(uuid) from public, anon;
grant execute on function private.product_row(uuid) to authenticated;

-- ----------------------------------------------------------- owner calls

-- Saves a product and makes as many units available as product.quantity
-- says (0 to 99). product: {id?, name, category, language, description,
-- price_brl, photos: [paths], quantity, active}. A new product passes the ID
-- its photos were uploaded under. Inactive, it offers no unit. Returns the
-- product as store_products_admin lists it.
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

	target := case when is_active then wanted else 0 end;

	select count(*) into have from public.store_listings l where l.kind = 'sealed' and l.card_id = pid::text and l.status = 'available';

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

-- Every product, newest first, with its units counted: for the admin page.
create or replace function public.store_products_admin()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	perform private.release_expired();

	return coalesce((select jsonb_agg(private.product_row(p.id) order by p.created_at desc) from public.store_products p), '[]');
end;
$$;

-- ----------------------------------------------------------- public call

-- What HOTARU's Selados page shows: every active product with a unit for
-- sale, newest first, with the IDs of its available units (what the cart
-- holds). Expired orders let their units go first.
create or replace function public.store_sealed()
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
		'category', p.category,
		'description', p.description,
		'id', p.id,
		'language', p.language,
		'name', p.name,
		'photos', to_jsonb(p.photos),
		'price_brl', p.price_brl,
		'units', u.ids
	) order by p.created_at desc), '[]')
	into result
	from public.store_products p
	join lateral (
		select array_agg(l.id order by l.published_at) as ids
		from public.store_listings l
		where l.kind = 'sealed' and l.card_id = p.id::text and l.status = 'available'
	) u on u.ids is not null
	where p.active;

	return result;
end;
$$;

-- ------------------------------------------------- the order calls, again

-- As in supabase/store-orders.sql, each item now naming its kind and card_id
-- (a sealed unit's is its product's ID), so the Shop screen and My orders
-- tell a product from a card. Repeated here so this one script is enough.

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


revoke all on function public.save_product(jsonb) from public, anon;
revoke all on function public.store_products_admin() from public, anon;
revoke all on function public.store_sealed() from public;
revoke all on function public.order_status(uuid[]) from public;
revoke all on function public.store_orders_open() from public, anon;

grant execute on function public.save_product(jsonb) to authenticated;
grant execute on function public.store_products_admin() to authenticated;
grant execute on function public.store_sealed() to anon, authenticated;
grant execute on function public.order_status(uuid[]) to anon, authenticated;
grant execute on function public.store_orders_open() to authenticated;
