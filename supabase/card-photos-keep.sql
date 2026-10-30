-- Card Tracker: never delete a photo file a card still shows (optional,
-- recommended while any phone may still run v47).
--
-- What it does: replaces the "card-photos: delete own" rule from
-- supabase/photos.sql with one that also refuses to delete a file while the
-- owner's document still shows it: a live photo on a card's record in the
-- card_info list (js/card-info.js, from v48), or that photo's detail copy.
--
-- Why: from v48, photos belong to the card, not the copy, and deleting
-- copies never deletes a photo (DESIGN.md, "Photos and notes belong to the
-- card, not the copy"). A phone still on v47 does not know that: after a
-- sync it queues the files of a deleted copy's photos for deletion, and
-- deletes them 14 days later. v48 hides the moved photos from v47 so this
-- does not happen in the usual case, but a v47 phone that deleted copies
-- while offline, or that queued deletes before v48 arrived, would still
-- send them. With this rule the server keeps those files. Nothing else
-- changes: removing a photo in the app still deletes its file after 14
-- days, once the server holds the removal.
--
-- What a v47 phone sees: nothing. The bucket answers its delete without an
-- error and keeps the file, and the phone drops the delete from its queue.
--
-- When to run it: any time from now on, before or after v48 is live, and
-- best before deleting any cards to start the collection over. Before v48
-- has synced, no document has card_info, so the rule behaves exactly like
-- the old one. If supabase/photos.sql is ever run again, run this file
-- after it, since photos.sql puts the old rule back.
--
-- Where to run it: Supabase dashboard, SQL Editor, New query, after
-- supabase/setup.sql and supabase/photos.sql. Paste this whole file and
-- click Run. Running it again is safe: the helper and the rule are
-- replaced.
--
-- To check it worked: Storage, Policies lists "card-photos: delete own"
-- with private.photo_in_use in its definition.
--
-- To undo it: run supabase/photos.sql again.

do $$
begin
	if to_regprocedure('private.photo_owner(text)') is null then
		raise exception 'Run supabase/photos.sql first: this script uses its private.photo_owner rule.';
	end if;
end;
$$;

-- True while the owner's document shows the file: a live photo of a live
-- card record whose path is the file, or whose detail copy it is
-- (<path without extension>-detail.<ext>, js/photos/model.js detailPath).
-- It runs with the caller's rights, and only the owner can delete, so it
-- reads the caller's own documents row.
create or replace function private.photo_in_use(object_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
	select exists (
		select 1
		from public.documents d
		cross join lateral jsonb_array_elements(
			case when jsonb_typeof(d.doc -> 'card_info') = 'array' then d.doc -> 'card_info' else '[]'::jsonb end
		) as r(record)
		cross join lateral jsonb_array_elements(
			case when jsonb_typeof(r.record -> 'photos') = 'array' then r.record -> 'photos' else '[]'::jsonb end
		) as p(photo)
		cross join lateral (
			select regexp_replace(p.photo ->> 'path', '\.(webp|jpe?g)$', '') || '-detail.' as detail_prefix
		) as f
		where d.user_id = private.photo_owner(object_name)
			and coalesce(r.record ->> 'deleted_at', '') = ''
			and coalesce(p.photo ->> 'deleted_at', '') = ''
			and (p.photo ->> 'path') is not null
			and (
				object_name = p.photo ->> 'path'
				or left(object_name, length(f.detail_prefix)) = f.detail_prefix
			)
	);
$$;

revoke all on function private.photo_in_use(text) from public, anon;
grant execute on function private.photo_in_use(text) to authenticated;

drop policy if exists "card-photos: delete own" on storage.objects;

create policy "card-photos: delete own" on storage.objects
	for delete to authenticated
	using (
		bucket_id = 'card-photos'
		and private.photo_owner(name) = (select auth.uid())
		and not private.photo_in_use(name)
	);
