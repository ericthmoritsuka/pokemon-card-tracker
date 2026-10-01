-- Card Tracker: live updates through Supabase Realtime (optional).
--
-- What it does: adds the documents table to the supabase_realtime
-- publication, so a device with the app open hears within seconds that the
-- signed-in person's row changed on another device, and syncs (js/sync.js,
-- the "live" section). Nothing else changes: the row-level security in
-- supabase/setup.sql still decides who hears about which row, so a person
-- hears only about their own row.
--
-- Without it the app works the same, a little slower: a device in front
-- reads updated_at once a minute and syncs when the window gets focus.
--
-- Where to run it: Supabase dashboard, SQL Editor, New query, after
-- supabase/setup.sql. Paste this whole file and click Run. Running it again
-- is safe: it adds the table only when it is not in the publication yet.
--
-- To undo it: alter publication supabase_realtime drop table public.documents;

do $$
begin
	-- Supabase creates this publication with every project; the guard is for
	-- a plain Postgres, such as a local check.
	if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
		create publication supabase_realtime;
	end if;

	if not exists (
		select 1
		from pg_publication_tables
		where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents'
	) then
		alter publication supabase_realtime add table public.documents;
	end if;
end;
$$;
