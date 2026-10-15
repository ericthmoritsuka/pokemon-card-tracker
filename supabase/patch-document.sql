-- Card Tracker: save only what changed (optional).
--
-- What it does: adds one function, patch_document, that the app calls to
-- save a small change. The app sends only the entries the change touched
-- (its sync_delta, js/merge.js), and the function puts them into the
-- signed-in person's documents row on the server, instead of the app
-- uploading the whole document. One edit with 1,600 cards then sends about
-- 1 KB instead of about 425 KB.
--
-- Without it the app works the same and uploads the whole document on each
-- save: when the function is missing, the app notices once per load and
-- goes on with the whole-document save.
--
-- The patch, {base, lists, top}:
--   base   the row's updated_at the change was merged against. The function
--          changes the row only while updated_at still equals it, the same
--          compare-and-set guard as the app's whole-document save, and
--          returns null otherwise, so the app reads again and retries.
--   lists  {"cards": [entry, ...], ...}: each entry replaces the one with the
--          same id in that list, or is added at its end.
--   top    the document's other fields (settings, base_stamp, and the rest),
--          which replace the stored ones.
-- The patch itself is kept as the document's sync_delta, so the account's
-- other devices read only that. It returns the row's new updated_at.
--
-- Who can do what: it runs with the caller's rights (security invoker), so
-- the row-level security in supabase/setup.sql still applies: a person
-- patches only their own row. It works beside supabase/min-client.sql: the
-- patch's top carries base_stamp equal to base.
--
-- Where to run it: Supabase dashboard, SQL Editor, New query, after
-- supabase/setup.sql. Paste this whole file and click Run. Running it again
-- is safe: the function is replaced.
--
-- To undo it: drop function if exists public.patch_document(jsonb);

create or replace function public.patch_document(patch jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
	me uuid := auth.uid();
	base timestamptz;
	d jsonb;
	list text;
	entries jsonb;
	stored jsonb;
	written timestamptz;
begin
	if me is null then
		raise exception 'Sign in first.' using errcode = '28000';
	end if;

	if jsonb_typeof(patch) is distinct from 'object'
		or jsonb_typeof(patch -> 'lists') is distinct from 'object'
		or jsonb_typeof(patch -> 'top') is distinct from 'object'
		or jsonb_typeof(patch -> 'base') is distinct from 'string' then
		raise exception 'A patch needs base, lists, and top.' using errcode = '22023';
	end if;

	base := (patch ->> 'base')::timestamptz;

	select doc into d
	from public.documents
	where user_id = me and updated_at = base
	for update;

	if not found then
		return null;
	end if;

	for list, entries in select key, value from jsonb_each(patch -> 'lists') loop
		if jsonb_typeof(entries) is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(entries) e where jsonb_typeof(e) is distinct from 'object' or (e ->> 'id') is null) then
			raise exception 'Every entry in a patch needs an id.' using errcode = '22023';
		end if;

		stored := case when jsonb_typeof(d -> list) = 'array' then d -> list else '[]'::jsonb end;

		d := jsonb_set(d, array[list],
			-- The stored entries in their order, each replaced by the patch's
			-- version when it has one ...
			coalesce((
				select jsonb_agg(coalesce(
					(select p from jsonb_array_elements(entries) p where p ->> 'id' = o.value ->> 'id' limit 1),
					o.value
				) order by o.n)
				from jsonb_array_elements(stored) with ordinality o(value, n)
			), '[]'::jsonb)
			-- ... then the patch's new entries in its order.
			|| coalesce((
				select jsonb_agg(p.value order by p.n)
				from jsonb_array_elements(entries) with ordinality p(value, n)
				where not exists (select 1 from jsonb_array_elements(stored) o where o ->> 'id' = p.value ->> 'id')
			), '[]'::jsonb));
	end loop;

	d := d || (patch -> 'top') || jsonb_build_object('sync_delta', patch);

	update public.documents
	set doc = d
	where user_id = me and updated_at = base
	returning updated_at into written;

	return written;
end;
$$;

-- Signed-in people only. Supabase grants new functions to anon by default,
-- so that grant is taken back explicitly.
revoke all on function public.patch_document(jsonb) from public, anon;
grant execute on function public.patch_document(jsonb) to authenticated;
