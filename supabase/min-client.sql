-- Card Tracker: refuse saves from apps older than merge_version 2 (optional).
--
-- What it does: adds a trigger that refuses an update to a documents row
-- unless the document carries base_stamp equal to the row's current
-- updated_at. Apps from merge_version 2 on always send it: base_stamp is the
-- updated_at they read and merged against (js/sync.js, outgoing), the same
-- value their compare-and-set guard already checks. An older app never sets
-- base_stamp; it only carries an old one along, or none, and the server's
-- updated_at moves on every write (supabase/setup.sql, touch_updated_at), so
-- every update from an older app is refused. Inserts (a first upload) pass.
--
-- Why: the merge is correct with older apps around, but an older app's edit
-- can only be merged entry by entry, never field by field. Once every phone
-- runs the new app, this makes sure a phone that was never reloaded cannot
-- keep writing by the old rules.
--
-- What an older app sees: "Not saved, N changes waiting". Its edits stay on
-- the phone, and after a Reload the new app merges them in. Nothing is lost.
--
-- When to run it: only after every family phone has opened the release with
-- merge_version 2 and been reloaded once (the app shows no version number, so
-- reload each phone by hand after the release). Run earlier, it blocks
-- nobody's data, but it stops syncing on any phone still on an older version
-- until it reloads.
--
-- Where to run it: Supabase dashboard, SQL Editor, New query, after
-- supabase/setup.sql. Paste this whole file and click Run. Running it again
-- is safe: the function and the trigger are replaced.
--
-- To undo it: drop trigger if exists documents_min_client on public.documents;

create or replace function public.check_min_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	if (new.doc ->> 'base_stamp') is null
		or (new.doc ->> 'base_stamp')::timestamptz is distinct from old.updated_at then
		raise exception 'This app is out of date. Reload it to keep syncing; your changes are kept on the phone.'
			using errcode = 'P0001', hint = 'min-client';
	end if;

	return new;
end;
$$;

drop trigger if exists documents_min_client on public.documents;

create trigger documents_min_client
	before update on public.documents
	for each row execute function public.check_min_client();
