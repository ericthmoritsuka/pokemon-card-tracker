-- Card Tracker: a private place for scan reports.
--
-- What it does: creates the private Storage bucket scan-reports and the
-- rules for who can use it. Phone check's Send report puts the scan log
-- there (js/scan/reports.js; DESIGN.md, "Send report"), so Eric can open
-- it under Profile > Phone check > Sent reports on any device he is signed
-- in on, with no file to download, find, or attach. Each report is a few
-- files under the sender's own folder:
--
--     <user_id>/<sent at>-<scans>.json.gz          the scan log, gzipped
--     <user_id>/<sent at>-<scans>.meta.json        its note and numbers
--
-- <sent at> is like 20261105T101919.274Z. A browser that cannot gzip sends
-- .json instead, and a log over 5 MB goes up in parts
-- (.json.gz.part1of3 and so on). A log of 30 cards with pictures is about
-- 0.9 MB gzipped (1.3 MB as a file), and up to about 2 MB in holder mode,
-- which also keeps the view before and after each drop.
--
-- Why a bucket of its own: card-photos (supabase/photos.sql) is readable by
-- the family group. Scan reports are not: they hold the phone's details and
-- pictures of every scan, so only the person who sent one reads it.
--
-- When and where to run it: once, before the first Send report (until then
-- Send report keeps the report on the phone and says the server has no
-- place for it yet). Supabase dashboard, SQL Editor, New query. Paste this
-- whole file and click Run. It needs nothing else, but runs after
-- supabase/setup.sql like the other scripts. Running it again is safe: the
-- bucket is created only when missing (its settings are put back if they
-- changed), and the rules are replaced.
--
-- To check it worked: Storage in the dashboard lists scan-reports, marked
-- Private, and Storage, Policies lists three "scan-reports:" rules (read
-- own, add own, delete own) under it. Then in the app: Phone check, Send
-- report, and the report appears in Sent reports.
--
-- Who can do what:
--   - Everyone adds files only under their own folder, <their id>/, and
--     only in the name shapes above, gzip or JSON, at most 6 MB each.
--   - Everyone lists, reads, and deletes only their own files. No family
--     member reads another's reports.
--   - Nobody replaces a file: a report never changes once sent.
--   - Nobody signed out reads anything: the bucket is private, so there are
--     no public links.
--
-- To undo it: in the dashboard, Storage, scan-reports, select every file
-- and delete them (Storage does not let SQL delete files), then delete the
-- bucket from its menu. Then run, in the SQL Editor:
--
--     drop policy if exists "scan-reports: read own" on storage.objects;
--     drop policy if exists "scan-reports: add own" on storage.objects;
--     drop policy if exists "scan-reports: delete own" on storage.objects;
--
-- Send report then keeps reports on the phone, with the same "no place for
-- reports yet" note, and the scan log is untouched.

-- ------------------------------------------------------------------ bucket

-- Private, at most 6 MB per file (the app sends at most 5 MiB per file),
-- gzip or JSON.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scan-reports', 'scan-reports', false, 6291456, array['application/gzip', 'application/json'])
on conflict (id) do update
set
	name = excluded.name,
	public = false,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

-- --------------------------------------------------------------- policies

-- Storage keeps its files as rows of storage.objects, which has row-level
-- security on. These rules apply to the scan-reports bucket only. The first
-- folder of a file's name is its owner's user ID, compared as text, so a
-- name with any other first folder matches no one. Listing a folder reads
-- through the read rule, so a list shows only the person's own files.

drop policy if exists "scan-reports: read own" on storage.objects;
drop policy if exists "scan-reports: add own" on storage.objects;
drop policy if exists "scan-reports: delete own" on storage.objects;

create policy "scan-reports: read own" on storage.objects
	for select to authenticated
	using (
		bucket_id = 'scan-reports'
		and (storage.foldername(name))[1] = (select auth.uid())::text
	);

create policy "scan-reports: add own" on storage.objects
	for insert to authenticated
	with check (
		bucket_id = 'scan-reports'
		and (storage.foldername(name))[1] = (select auth.uid())::text
		and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]{8}T[0-9]{6}\.[0-9]{3}Z-[0-9]{1,4}\.(meta\.json|json(\.gz)?(\.part[0-9]{1,3}of[0-9]{1,3})?)$'
	);

create policy "scan-reports: delete own" on storage.objects
	for delete to authenticated
	using (
		bucket_id = 'scan-reports'
		and (storage.foldername(name))[1] = (select auth.uid())::text
	);
