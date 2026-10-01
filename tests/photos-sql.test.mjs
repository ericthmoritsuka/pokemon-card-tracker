// Checks supabase/photos.sql against a throwaway Postgres container, with a
// minimal stand-in for Supabase's auth and storage schemas and roles (the
// same approach as tests/setup-sql-check.sh). It runs supabase/setup.sql,
// then photos.sql twice (it must be idempotent), then tries every storage
// rule as three made-up users: the family owner, a member, and a stranger.
// Nothing touches the real Supabase project.
//
// The stand-in storage.objects is a plain table with row-level security on
// and the grants Supabase gives the API roles, so the checks exercise the
// policies' logic, not Supabase's Storage server.
//
// Needs Docker or Podman; skipped without either.
//
// Run: node --test tests/photos-sql.test.mjs

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const engine = ['docker', 'podman'].find((name) => spawnSync(name, ['info'], {stdio: 'ignore'}).status === 0);
const name = `card-tracker-photos-sql-${process.pid}`;

const run = (args, options = {}) => spawnSync(engine, args, {encoding: 'utf8', ...options});

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';

const STAND_IN = `
\\set ON_ERROR_STOP on
set client_min_messages = warning;

-- Roles belong to the whole server, so a second database finds them.
do $$ begin
	create role anon nologin;
	create role authenticated nologin;
exception when duplicate_object then null;
end $$;
create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
	$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated;

-- Supabase's storage tables, reduced to the columns the script and the
-- checks touch.
create schema storage;
grant usage on schema storage to anon, authenticated;
create table storage.buckets (
	id text primary key,
	name text not null,
	public boolean default false,
	file_size_limit bigint,
	allowed_mime_types text[],
	created_at timestamptz default now()
);
create table storage.objects (
	id uuid primary key default gen_random_uuid(),
	bucket_id text references storage.buckets (id),
	name text,
	owner uuid default auth.uid(),
	metadata jsonb,
	created_at timestamptz default now(),
	unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
`;

const CHECKS = `
${STAND_IN}

insert into auth.users values
	('${A}', 'owner@example.test'),
	('${B}', 'kid@example.test'),
	('${C}', 'stranger@example.test');

\\ir ../supabase/setup.sql
\\ir ../supabase/photos.sql
\\ir ../supabase/photos.sql

-- One private bucket with the limits, however often the script ran.
do $$ begin
	if (select count(*) from storage.buckets where id = 'card-photos') <> 1 then raise exception 'bucket count'; end if;
	if (select public from storage.buckets where id = 'card-photos') then raise exception 'bucket is public'; end if;
	if (select file_size_limit from storage.buckets where id = 'card-photos') <> 524288 then raise exception 'size limit'; end if;
	if (select allowed_mime_types from storage.buckets where id = 'card-photos') <> array['image/webp', 'image/jpeg'] then raise exception 'mime types'; end if;
	if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'card-photos:%') <> 4 then raise exception 'policy count'; end if;
end $$;

-- A second bucket someone adds later, with no rules, stays closed.
insert into storage.buckets (id, name) values ('other', 'other');

create function pg_temp.act_as(who text) returns void language sql as $$
	select set_config('request.jwt.claim.sub', who, false);
$$;

create function pg_temp.expect_error(statement text, fragment text) returns void language plpgsql as $$
begin
	execute statement;
	raise exception 'Expected an error containing "%" from: %', fragment, statement;
exception when others then
	if position(fragment in sqlerrm) = 0 then
		raise exception 'Wrong error from %: %', statement, sqlerrm;
	end if;
end;
$$;

create function pg_temp.affected(statement text) returns bigint language plpgsql as $$
declare n bigint;
begin
	execute statement;
	get diagnostics n = row_count;

	return n;
end;
$$;

grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- The owner makes the family group and adds the kid; the stranger is in no
-- group.
select pg_temp.act_as('${A}');
select public.claim_owner('Family');
select public.add_member('kid@example.test');

-- The owner uploads under their own folder, in the one path shape.
insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/entry-1/photo-1.webp');
insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/entry-1/photo-2.jpg');

-- Not under someone else's folder, not a loose or odd path, not another
-- bucket.
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('card-photos', '${B}/entry-1/photo-1.webp')$$, 'row-level security');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/photo.webp')$$, 'row-level security');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/entry-1/photo-1.png')$$, 'row-level security');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/../${B}/photo-1.webp')$$, 'row-level security');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('card-photos', 'not-a-user/entry-1/photo-1.webp')$$, 'row-level security');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('other', '${A}/entry-1/photo-1.webp')$$, 'row-level security');

-- A photo's detail copy (js/photos/model.js detailPath) sits beside it with
-- the app's real ids, UUIDs, plus -detail: the same rules take it with no
-- change to photos.sql. The kid reads it, and the owner deletes it.
insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/7c9e6679-7425-40de-944b-e07fc1f90ae7/f47ac10b-58cc-4372-a567-0e02b2c3d479-detail.webp');
insert into storage.objects (bucket_id, name) values ('card-photos', '${A}/7c9e6679-7425-40de-944b-e07fc1f90ae7/f47ac10b-58cc-4372-a567-0e02b2c3d479-detail.jpg');
select pg_temp.expect_error($$insert into storage.objects (bucket_id, name) values ('card-photos', '${B}/7c9e6679-7425-40de-944b-e07fc1f90ae7/f47ac10b-58cc-4372-a567-0e02b2c3d479-detail.webp')$$, 'row-level security');
select pg_temp.act_as('${B}');

do $$ begin
	if (select count(*) from storage.objects where name like '%-detail.%') <> 2 then raise exception 'member should read the detail copies'; end if;
end $$;

select pg_temp.act_as('${A}');

do $$ begin
	if pg_temp.affected($q$delete from storage.objects where name like '%-detail.%'$q$) <> 2 then raise exception 'owner could not delete the detail copies'; end if;
end $$;

-- The kid (a member) uploads their own, reads both people's, and cannot
-- change or delete the owner's: those rows are invisible to the change, so
-- nothing happens.
select pg_temp.act_as('${B}');
insert into storage.objects (bucket_id, name) values ('card-photos', '${B}/entry-9/photo-9.webp');

do $$ begin
	if (select count(*) from storage.objects where bucket_id = 'card-photos') <> 3 then raise exception 'member should read own and owner photos'; end if;
	if pg_temp.affected($q$delete from storage.objects where name like '${A}/%'$q$) <> 0 then raise exception 'member deleted owner photo'; end if;
	if pg_temp.affected($q$update storage.objects set metadata = '{}' where name like '${A}/%'$q$) <> 0 then raise exception 'member changed owner photo'; end if;
end $$;

-- Moving one's own photo into someone else's folder is refused.
select pg_temp.expect_error($$update storage.objects set name = '${A}/entry-9/photo-9.webp' where name = '${B}/entry-9/photo-9.webp'$$, 'row-level security');

-- The stranger sees nothing of the family, only their own.
select pg_temp.act_as('${C}');

do $$ begin
	if (select count(*) from storage.objects) <> 0 then raise exception 'stranger reads family photos'; end if;
end $$;

insert into storage.objects (bucket_id, name) values ('card-photos', '${C}/entry-5/photo-5.webp');

do $$ begin
	if (select count(*) from storage.objects) <> 1 then raise exception 'stranger should read only their own'; end if;
	if pg_temp.affected($q$delete from storage.objects where name like '${B}/%'$q$) <> 0 then raise exception 'stranger deleted a photo'; end if;
end $$;

-- The owner does not see the stranger's photo, replaces their own (an
-- upsert), and deletes their own.
select pg_temp.act_as('${A}');

do $$ begin
	if (select count(*) from storage.objects) <> 3 then raise exception 'owner should read own and member photos only'; end if;
	if pg_temp.affected($q$update storage.objects set metadata = '{"size": 1}' where name = '${A}/entry-1/photo-1.webp'$q$) <> 1 then raise exception 'owner could not replace own photo'; end if;
	if pg_temp.affected($q$delete from storage.objects where name = '${A}/entry-1/photo-2.jpg'$q$) <> 1 then raise exception 'owner could not delete own photo'; end if;
end $$;

-- Signed out: nothing.
reset role;
set role anon;
select pg_temp.act_as('');

do $$ begin
	if (select count(*) from storage.objects) <> 0 then raise exception 'anon reads photos'; end if;
end $$;

reset role;
\\echo PHOTOS SQL CHECKS PASSED
`;

// photos.sql on a database where setup.sql never ran stops with a clear
// message instead of half-applying.
const WITHOUT_SETUP = `
${STAND_IN}
\\ir ../supabase/photos.sql
`;

let ready = false;

before(() => {
	if (!engine) {
		return;
	}

	const started = run(['run', '--detach', '--env', 'POSTGRES_PASSWORD=check', '--name', name, '--rm', 'postgres:17-alpine']);

	assert.equal(started.status, 0, started.stderr);

	for (let i = 0; i < 60; i++) {
		if (run(['exec', name, 'pg_isready', '--username=postgres']).status === 0
			&& run(['exec', name, 'psql', '--username=postgres', '--command=select 1']).status === 0) {
			ready = true;
			break;
		}

		spawnSync('sleep', ['1']);
	}

	assert.ok(ready, 'Postgres started');

	const dir = mkdtempSync(join(tmpdir(), 'photos-sql-'));

	writeFileSync(join(dir, 'checks.sql'), CHECKS);
	writeFileSync(join(dir, 'without-setup.sql'), WITHOUT_SETUP);

	run(['exec', name, 'mkdir', '-p', '/check/supabase', '/check/tests']);

	for (const file of ['setup.sql', 'photos.sql']) {
		assert.equal(run(['cp', join(ROOT, 'supabase', file), `${name}:/check/supabase/${file}`]).status, 0);
	}

	assert.equal(run(['cp', join(dir, 'checks.sql'), `${name}:/check/tests/checks.sql`]).status, 0);
	assert.equal(run(['cp', join(dir, 'without-setup.sql'), `${name}:/check/tests/without-setup.sql`]).status, 0);
	assert.equal(run(['exec', name, 'createdb', '--username=postgres', 'fresh']).status, 0);
});

after(() => {
	if (engine) {
		run(['stop', name]);
	}
});

test('photos.sql: idempotent, private bucket, owner-only writes, family reads', {skip: !engine && 'Docker or Podman is not available'}, () => {
	const result = run(['exec', name, 'psql', '--quiet', '--username=postgres', '--file=/check/tests/checks.sql']);

	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /PHOTOS SQL CHECKS PASSED/);
});

test('photos.sql stops with a clear message when setup.sql has not run', {skip: !engine && 'Docker or Podman is not available'}, () => {
	const result = run(['exec', name, 'psql', '--quiet', '--username=postgres', '--dbname=fresh', '--file=/check/tests/without-setup.sql']);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Run supabase\/setup\.sql first/);
});
