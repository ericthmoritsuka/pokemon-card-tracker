-- Card Tracker: storage for the owner's card photos.
--
-- What it does: creates the private Storage bucket card-photos and the rules
-- for who can use it. Each photo is a straightened card image of about
-- 80 KB (WebP, or JPEG on a phone that cannot make WebP), stored at
--
--     <user_id>/<entry_id>/<photo_id>.webp
--
-- so the first folder says whose card it is. DESIGN.md section 5 ("Own
-- photos, cropped to the card") explains the photos; section 8 the free
-- tier's 1 GB of file storage, which holds over 10,000 of them.
--
-- Run it after supabase/setup.sql, which it relies on (the family-group
-- rule private.shares_group). Where: Supabase dashboard, SQL Editor, New
-- query. Paste this whole file and click Run. Running it again is safe: the
-- bucket is created only when missing (its settings are put back if they
-- changed), and the helper and rules are replaced.
--
-- To check it worked: Storage in the dashboard lists card-photos, marked
-- Private, and Storage, Policies lists the four "card-photos:" rules.
--
-- Who can do what:
--   - Everyone uploads, replaces, and deletes only under their own folder,
--     and only a .webp or .jpg file at <their id>/<entry id>/<photo id>.
--   - Everyone reads their own photos and those of anyone who shares a
--     family group with them, as with the cards themselves. Someone in no
--     group reads only their own.
--   - Nobody signed out reads anything: the bucket is private, so there are
--     no public links.

-- ----------------------------------------------------------- prerequisite

do $$
begin
	if to_regprocedure('private.shares_group(uuid)') is null then
		raise exception 'Run supabase/setup.sql first: this script uses its private.shares_group rule.';
	end if;
end;
$$;

-- ------------------------------------------------------------------ bucket

-- Private, at most 512 KB per file (a photo is about 80 KB), WebP or JPEG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-photos', 'card-photos', false, 524288, array['image/webp', 'image/jpeg'])
on conflict (id) do update
set
	name = excluded.name,
	public = false,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

-- ------------------------------------------------------------------ helper

-- The user a photo belongs to: the first folder of its path, when that is
-- a user ID. Null for any other path, so a rule comparing it matches no one.
create or replace function private.photo_owner(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
	select case
		when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then split_part(object_name, '/', 1)::uuid
	end;
$$;

-- True for the one path shape the app writes:
-- <user id>/<entry id>/<photo id>.webp or .jpg.
create or replace function private.is_photo_path(object_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$';
$$;

revoke all on function private.photo_owner(text) from public, anon;
revoke all on function private.is_photo_path(text) from public, anon;
grant execute on function private.photo_owner(text) to authenticated;
grant execute on function private.is_photo_path(text) to authenticated;

-- --------------------------------------------------------------- policies

-- Storage keeps its files as rows of storage.objects, which has row-level
-- security on. These rules apply to the card-photos bucket only. An upload
-- that replaces a file (the app always uploads that way) needs the read,
-- add, and replace rules together.

drop policy if exists "card-photos: read own and group" on storage.objects;
drop policy if exists "card-photos: add own" on storage.objects;
drop policy if exists "card-photos: replace own" on storage.objects;
drop policy if exists "card-photos: delete own" on storage.objects;

create policy "card-photos: read own and group" on storage.objects
	for select to authenticated
	using (
		bucket_id = 'card-photos'
		and (
			private.photo_owner(name) = (select auth.uid())
			or private.shares_group(private.photo_owner(name))
		)
	);

create policy "card-photos: add own" on storage.objects
	for insert to authenticated
	with check (
		bucket_id = 'card-photos'
		and private.is_photo_path(name)
		and private.photo_owner(name) = (select auth.uid())
	);

create policy "card-photos: replace own" on storage.objects
	for update to authenticated
	using (
		bucket_id = 'card-photos'
		and private.photo_owner(name) = (select auth.uid())
	)
	with check (
		bucket_id = 'card-photos'
		and private.is_photo_path(name)
		and private.photo_owner(name) = (select auth.uid())
	);

create policy "card-photos: delete own" on storage.objects
	for delete to authenticated
	using (
		bucket_id = 'card-photos'
		and private.photo_owner(name) = (select auth.uid())
	);
