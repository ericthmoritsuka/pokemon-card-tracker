-- Card Tracker: the HOTARU blog (Eric, 2026-11-25).
--
-- What it does: keeps the posts Eric writes on HOTARU's admin page (title,
-- category, cover photo, summary, and a body written in a visual editor), the
-- owner's calls that save and list them, and the two public calls HOTARU's
-- Blog pages read (store_posts_public and store_post). A draft is never
-- public. It also lets the public store bucket take a post's photos, under
-- blog/<post id>/<name>.jpg.
--
-- Run it after supabase/store.sql. Where: Supabase dashboard, SQL Editor,
-- New query. Paste this whole file and click Run. Running it again is safe.
--
-- To check it worked: Table Editor lists store_posts; Database, Functions
-- lists save_post, store_posts_admin, store_posts_public, and store_post.
--
-- The body is the editor's own structured format (a Quill Delta: {"ops":
-- [...]}), never HTML. The pages build it into the page element by element,
-- so nothing typed or pasted into a post can run as code on a visitor's
-- browser. A picture in the body is a store bucket path inside the post's own
-- folder, and a video is a YouTube video ID: save_post refuses anything else.
--
-- The bucket's path rule, private.is_store_path, is left alone: the blog has
-- its own upload rule below, so this file never has to repeat that function's
-- other branches.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regprocedure('private.is_store_owner()') is null then
		raise exception 'Run supabase/store.sql first: this script uses its owner check and its bucket.';
	end if;
end;
$$;

-- ------------------------------------------------------------------- table

create table if not exists public.store_posts (
	id uuid primary key default gen_random_uuid(),
	-- The post's address: post.html?p=<slug>. Made from the title on the
	-- first save, then kept, so a shared link keeps working.
	slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 90),
	title text not null check (char_length(title) between 1 and 140),
	-- Pokémon TCG, Coleção, Outros, and so on, as Eric types it.
	category text check (category is null or char_length(category) <= 40),
	-- What the list shows under the title: the summary Eric typed, else the
	-- start of the text, which the admin page fills in.
	summary text check (summary is null or char_length(summary) <= 300),
	excerpt text check (excerpt is null or char_length(excerpt) <= 300),
	-- A path in the public store bucket, in this post's folder.
	cover text,
	body jsonb not null default '{"ops": []}' check (jsonb_typeof(body) = 'object' and jsonb_typeof(body->'ops') = 'array' and octet_length(body::text) <= 200000),
	status text not null default 'draft' check (status in ('draft', 'published')),
	-- Set on the first publish and kept, even if the post goes back to draft
	-- and is published again.
	published_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

alter table public.store_posts enable row level security;

revoke all on public.store_posts from anon;
revoke insert, update, delete on public.store_posts from authenticated;

drop policy if exists "store_posts: owner reads" on public.store_posts;

create policy "store_posts: owner reads" on public.store_posts
	for select to authenticated
	using (private.is_store_owner());

-- ------------------------------------------------------------------ photos

-- A post's photo: blog/<post id>/<name>.webp, .jpg, or .png.
create or replace function private.is_blog_path(object_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select object_name ~ '^blog/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}\.(webp|jpg|png)$';
$$;

revoke all on function private.is_blog_path(text) from public, anon;
grant execute on function private.is_blog_path(text) to authenticated;

-- The owner adds a post's photos. Reading, replacing, and deleting files in
-- the bucket are already the owner's by supabase/store.sql's rules; this one
-- only adds the blog's folder to what an upload may create.
drop policy if exists "store: owner adds blog photos" on storage.objects;

create policy "store: owner adds blog photos" on storage.objects
	for insert to authenticated
	with check (bucket_id = 'store' and private.is_blog_path(name) and private.is_store_owner());

-- ------------------------------------------------------------------ helpers

-- A post as the admin page lists it, body included.
create or replace function private.post_row(post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'body', p.body,
		'category', p.category,
		'cover', p.cover,
		'created_at', p.created_at,
		'excerpt', p.excerpt,
		'id', p.id,
		'published_at', p.published_at,
		'slug', p.slug,
		'status', p.status,
		'summary', p.summary,
		'title', p.title,
		'updated_at', p.updated_at
	)
	from public.store_posts p
	where p.id = post_id;
$$;

revoke all on function private.post_row(uuid) from public, anon;
grant execute on function private.post_row(uuid) to authenticated;

-- The title as an address: lowercase, no accents, words joined by hyphens.
create or replace function private.slugify(title text)
returns text
language sql
immutable
set search_path = ''
as $$
	select coalesce(nullif(left(btrim(regexp_replace(lower(translate(coalesce(title, ''),
		'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
		'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')), '[^a-z0-9]+', '-', 'g'), '-'), 80), ''), 'post');
$$;

-- ----------------------------------------------------------- owner calls

-- Saves a post. post: {id?, title, category, summary, excerpt, cover, body,
-- status}. A new post passes the ID its photos were uploaded under. Returns
-- the post as store_posts_admin lists it.
create or replace function public.save_post(post jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	pid uuid := coalesce(nullif(post->>'id', '')::uuid, gen_random_uuid());
	clean_title text := btrim(coalesce(post->>'title', ''));
	clean_category text := nullif(btrim(coalesce(post->>'category', '')), '');
	clean_summary text := nullif(btrim(coalesce(post->>'summary', '')), '');
	clean_excerpt text := nullif(left(btrim(coalesce(post->>'excerpt', '')), 300), '');
	clean_cover text := nullif(btrim(coalesce(post->>'cover', '')), '');
	new_body jsonb := coalesce(post->'body', '{"ops": []}');
	new_status text := coalesce(post->>'status', 'draft');
	folder text := 'blog/' || pid::text || '/';
	kept_slug text;
	base text;
	candidate text;
	n int := 1;
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	if char_length(clean_title) not between 1 and 140 then
		raise exception 'Type a title of up to 140 characters.' using errcode = '22023';
	end if;

	if char_length(clean_category) > 40 then
		raise exception 'The category is at most 40 characters.' using errcode = '22023';
	end if;

	if char_length(clean_summary) > 300 then
		raise exception 'The summary is at most 300 characters.' using errcode = '22023';
	end if;

	if new_status not in ('draft', 'published') then
		raise exception 'A post is a draft or published.' using errcode = '22023';
	end if;

	if jsonb_typeof(new_body) <> 'object' or jsonb_typeof(new_body->'ops') is distinct from 'array' then
		raise exception 'The body is not in the editor''s format.' using errcode = '22023';
	end if;

	if octet_length(new_body::text) > 200000 then
		raise exception 'The post is too long.' using errcode = '22023';
	end if;

	if clean_cover is not null and (not private.is_blog_path(clean_cover) or clean_cover not like folder || '%') then
		raise exception 'The cover is not in this post''s folder.' using errcode = '22023';
	end if;

	-- Every embed in the body: a picture in this post's folder, or a YouTube
	-- video ID. Text inserts are plain strings and need no check.
	if exists (
		select 1
		from jsonb_array_elements(new_body->'ops') as op
		where jsonb_typeof(op) <> 'object'
			or (op ? 'insert' and jsonb_typeof(op->'insert') not in ('string', 'object'))
			or (jsonb_typeof(op->'insert') = 'object' and not (
				(op->'insert' ? 'image' and (select count(*) from jsonb_object_keys(op->'insert')) = 1
					and jsonb_typeof(op->'insert'->'image') = 'string'
					and private.is_blog_path(op->'insert'->>'image')
					and op->'insert'->>'image' like folder || '%')
				or (op->'insert' ? 'video' and (select count(*) from jsonb_object_keys(op->'insert')) = 1
					and jsonb_typeof(op->'insert'->'video') = 'string'
					and op->'insert'->>'video' ~ '^[A-Za-z0-9_-]{11}$')
			))
	) then
		raise exception 'The body has a picture outside this post''s folder, or something that is not a picture or a YouTube video.' using errcode = '22023';
	end if;

	-- The address: kept once made, else made from the title, with -2, -3 and
	-- so on when another post already has it.
	select p.slug into kept_slug from public.store_posts p where p.id = pid;

	if kept_slug is null then
		base := private.slugify(clean_title);
		candidate := base;

		while exists (select 1 from public.store_posts p where p.slug = candidate) loop
			n := n + 1;
			candidate := base || '-' || n;
		end loop;

		kept_slug := candidate;
	end if;

	insert into public.store_posts as p (id, slug, title, category, summary, excerpt, cover, body, status, published_at)
	values (pid, kept_slug, clean_title, clean_category, clean_summary, coalesce(clean_summary, clean_excerpt), clean_cover, new_body, new_status,
		case when new_status = 'published' then now() end)
	on conflict (id) do update
	set title = excluded.title, category = excluded.category, summary = excluded.summary, excerpt = excluded.excerpt,
		cover = excluded.cover, body = excluded.body, status = excluded.status,
		published_at = coalesce(p.published_at, excluded.published_at), updated_at = now();

	return private.post_row(pid);
end;
$$;

-- Every post, drafts included, the last changed first: for the admin page.
create or replace function public.store_posts_admin()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not private.is_store_owner() then
		raise exception 'Only the shop owner can do this.' using errcode = '42501';
	end if;

	return coalesce((select jsonb_agg(private.post_row(p.id) order by p.updated_at desc) from public.store_posts p), '[]');
end;
$$;

-- ----------------------------------------------------------- public calls

-- What HOTARU's Blog page and the home show: the published posts, newest
-- first, without their bodies.
create or replace function public.store_posts_public()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'category', p.category,
		'cover', p.cover,
		'excerpt', p.excerpt,
		'published_at', p.published_at,
		'slug', p.slug,
		'title', p.title
	) order by p.published_at desc, p.slug), '[]')
	from public.store_posts p
	where p.status = 'published';
$$;

-- One published post, body included, by its address; null for a draft or an
-- address that does not exist.
create or replace function public.store_post(post_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'body', p.body,
		'category', p.category,
		'cover', p.cover,
		'excerpt', p.excerpt,
		'published_at', p.published_at,
		'slug', p.slug,
		'title', p.title,
		'updated_at', p.updated_at
	)
	from public.store_posts p
	where p.slug = post_slug and p.status = 'published';
$$;

-- Supabase grants new functions to anon by default, so each grant is
-- explicit.
revoke all on function private.slugify(text) from public, anon, authenticated;
revoke all on function public.save_post(jsonb) from public, anon;
revoke all on function public.store_posts_admin() from public, anon;
revoke all on function public.store_posts_public() from public;
revoke all on function public.store_post(text) from public;

grant execute on function public.save_post(jsonb) to authenticated;
grant execute on function public.store_posts_admin() to authenticated;
grant execute on function public.store_posts_public() to anon, authenticated;
grant execute on function public.store_post(text) to anon, authenticated;
