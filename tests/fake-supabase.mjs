// A stand-in for the Supabase project, answered from Playwright's page.route,
// so the tests never reach the real auth or data endpoints, never create an
// account, and never send an email.
//
// It imitates only what the app uses: the auth endpoints for email links,
// Google, PKCE code exchange, password sign-in, password change, refresh,
// and sign-out; the auth settings; and
// PostgREST for the four tables and four functions in supabase/setup.sql,
// with the same row-level rules. updated_at is set by the "server" on every
// write, as the trigger does. A select may name a JSON path
// (favorite:doc->settings->favorite_pokemon), and a filter may be in.(...).
//
// revoke(userId) ends every session the account has, as
// supabase/reset-password.sql does: its refresh tokens are refused and its
// access tokens get 401 from PostgREST.

import {createHash, randomUUID} from 'node:crypto';

export const SUPABASE_ORIGIN = 'https://ehdkbxrjxsypegbtrxbw.supabase.co';
export const PUBLISHABLE_KEY = 'sb_publishable_Ycfz9bobfuvHWdDKjaoQQA_LDYmm0vJ';

const b64url = (value) => Buffer.from(value).toString('base64url');

function jwt(user, sessionId) {
	const now = Math.floor(Date.now() / 1000);

	return [
		b64url(JSON.stringify({alg: 'HS256', typ: 'JWT'})),
		b64url(JSON.stringify({aud: 'authenticated', email: user.email, exp: now + 3600, iat: now, role: 'authenticated', session_id: sessionId, sub: user.id})),
		b64url('fake-signature'),
	].join('.');
}

const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');

export class FakeSupabase {
	constructor({google = false} = {}) {
		this.google = google;
		this.users = new Map();
		this.passwords = new Map();
		this.challenges = new Map();
		this.codes = new Map();
		this.sessions = new Map();
		this.revoked = new Set();
		this.profiles = new Map();
		this.groups = [];
		this.members = [];
		this.documents = new Map();
		this.log = [];
		this.emails = [];
		this.clock = Date.parse('2026-10-01T12:00:00.000Z') * 1000;
		this.gates = [];
		this.sockets = [];
		this.changeIds = 0;
		// true: a change carries the whole row, doc included, as the real
		// server sends a row under Realtime's max_record_bytes (1 MB).
		this.realtimeDocs = false;
	}

	// A password makes it an account that signs in with one, as an account
	// made in the dashboard with "Create new user" does.
	addUser(email, {password = null} = {}) {
		const user = {
			app_metadata: {provider: 'email'},
			aud: 'authenticated',
			created_at: new Date().toISOString(),
			email,
			id: randomUUID(),
			role: 'authenticated',
			user_metadata: {},
		};

		this.users.set(user.id, user);

		if (password) {
			this.passwords.set(user.id, password);
		}

		return user;
	}

	userByEmail(email) {
		return [...this.users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase()) || null;
	}

	// The server's clock in microseconds, always moving forward, printed the
	// way PostgREST prints timestamptz.
	now() {
		this.clock += 1000 + Math.floor(Math.random() * 1000);

		const ms = Math.floor(this.clock / 1000);
		const micro = String(this.clock % 1000000).padStart(6, '0');

		return `${new Date(ms).toISOString().slice(0, 19)}.${micro}+00:00`;
	}

	// A code the email link (or Google) would carry back, tied to the PKCE
	// challenge the app sent when it asked for the link.
	issueCode(email) {
		const challenge = this.challenges.get(email.toLowerCase());
		const code = randomUUID();

		this.codes.set(code, {challenge, email});

		return code;
	}

	session(user) {
		const sessionId = randomUUID();
		const access = jwt(user, sessionId);
		const refresh = randomUUID();

		this.sessions.set(refresh, {sessionId, userId: user.id});

		return {
			access_token: access,
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			expires_in: 3600,
			refresh_token: refresh,
			token_type: 'bearer',
			user,
		};
	}

	// Holds the next matching request until release() is called: lets a test
	// put another device's write between this device's read and its write.
	gate(match) {
		let release;
		const held = new Promise((done) => {
			release = done;
		});
		let arrived;
		const reached = new Promise((done) => {
			arrived = done;
		});

		this.gates.push({arrived, held, match});

		return {reached, release};
	}

	// Ends every session of the account: refresh tokens are refused, and its
	// access tokens no longer pass.
	revoke(userId) {
		for (const [refresh, session] of this.sessions) {
			if (session.userId === userId) {
				this.revoked.add(session.sessionId);
				this.sessions.delete(refresh);
			}
		}
	}

	callerOf(request) {
		const headers = request.headers();
		const token = (headers.authorization || '').replace(/^Bearer /, '');

		return this.userOfToken(token);
	}

	sharesGroup(a, b) {
		const groupsOf = (id) => new Set(this.members.filter((member) => member.user_id === id).map((member) => member.group_id));
		const mine = groupsOf(a);

		return [...groupsOf(b)].some((group) => mine.has(group));
	}

	canRead(caller, userId) {
		return caller && (caller.id === userId || this.sharesGroup(caller.id, userId));
	}

	async attach(context, device = 'device') {
		await context.route(`${SUPABASE_ORIGIN}/**`, (route) => this.handle(route, device));

		// Realtime's WebSocket, which page.route does not see. Answered here, so
		// no test ever opens a socket to the real project.
		await context.routeWebSocket(`${SUPABASE_ORIGIN.replace(/^https/, 'wss')}/**`, (ws) => this.realtime(ws, device));
	}

	async handle(route, device) {
		const request = route.request();
		const url = new URL(request.url());

		if (request.method() === 'OPTIONS') {
			return route.fulfill({headers: this.cors(), status: 204});
		}

		const entry = {device, method: request.method(), path: url.pathname, search: url.search};
		let body = null;

		try {
			body = request.postData() ? JSON.parse(request.postData()) : null;
		}
		catch {
			body = request.postData();
		}

		entry.body = body;
		entry.bytes = (request.postData() || '').length;
		this.log.push(entry);

		for (const gate of [...this.gates]) {
			if (gate.match(entry)) {
				this.gates.splice(this.gates.indexOf(gate), 1);
				gate.arrived();
				await gate.held;
			}
		}

		// The browser opens /authorize as a page, with no API key, as it does
		// against the real project.
		const navigation = url.pathname === '/auth/v1/authorize';

		if (!navigation && request.headers().apikey !== PUBLISHABLE_KEY) {
			return this.json(route, 401, {message: 'No API key found in request'});
		}

		try {
			if (url.pathname.startsWith('/auth/v1/')) {
				return await this.auth(route, request, url, body);
			}

			if (url.pathname.startsWith('/rest/v1/')) {
				return await this.rest(route, request, url, body, entry);
			}
		}
		catch (err) {
			return this.json(route, 500, {message: String(err && err.stack)});
		}

		return this.json(route, 404, {message: 'Not found'});
	}

	cors() {
		return {
			'access-control-allow-headers': '*',
			'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
			'access-control-allow-origin': '*',
			'access-control-expose-headers': 'content-range, x-supabase-api-version',
		};
	}

	json(route, status, data, headers = {}) {
		return route.fulfill({
			body: data === undefined ? '' : JSON.stringify(data),
			contentType: 'application/json',
			headers: {...this.cors(), ...headers},
			status,
		});
	}

	// ------------------------------------------------------------- auth

	async auth(route, request, url, body) {
		const path = url.pathname.slice('/auth/v1'.length);

		if (path === '/settings') {
			return this.json(route, 200, {disable_signup: true, external: {email: true, google: this.google}});
		}

		if (path === '/otp') {
			const email = String(body.email).toLowerCase();

			// An address with no account: Supabase answers otp_disabled when
			// the client sends create_user false, and signup_disabled (with
			// sign-up closed) otherwise.
			if (!this.userByEmail(email)) {
				return body.create_user === false
					? this.json(route, 422, {code: 'otp_disabled', error_code: 'otp_disabled', msg: 'Signups not allowed for otp'})
					: this.json(route, 422, {code: 'signup_disabled', error_code: 'signup_disabled', msg: 'Signups not allowed for otp'});
			}

			this.challenges.set(email, body.code_challenge);
			this.emails.push({email, redirect: url.searchParams.get('redirect_to')});

			return this.json(route, 200, {});
		}

		if (path === '/authorize') {
			// Google: the browser leaves for Google and comes back with a code.
			const redirect = url.searchParams.get('redirect_to');
			const user = this.googleUser;
			const code = randomUUID();

			this.codes.set(code, {challenge: url.searchParams.get('code_challenge'), email: user.email});

			return route.fulfill({headers: {location: `${redirect}?code=${code}`}, status: 302});
		}

		if (path === '/token') {
			const grant = url.searchParams.get('grant_type');

			if (grant === 'pkce') {
				const found = this.codes.get(body.auth_code);

				if (!found || challengeOf(body.code_verifier) !== found.challenge) {
					return this.json(route, 400, {code: 'bad_code_verifier', error_code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier'});
				}

				this.codes.delete(body.auth_code);

				return this.json(route, 200, this.session(this.userByEmail(found.email)));
			}

			if (grant === 'password') {
				// One answer for an unknown address and a wrong password, as the
				// real server gives.
				const user = this.userByEmail(String(body.email || ''));

				if (!user || !this.passwords.has(user.id) || this.passwords.get(user.id) !== body.password) {
					return this.json(route, 400, {code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials'});
				}

				return this.json(route, 200, this.session(user));
			}

			if (grant === 'refresh_token') {
				const found = this.sessions.get(body.refresh_token);

				if (!found) {
					return this.json(route, 400, {code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found'});
				}

				return this.json(route, 200, this.session(this.users.get(found.userId)));
			}
		}

		if (path === '/user') {
			const caller = this.callerOf(request);

			if (!caller) {
				return this.json(route, 401, {msg: 'invalid JWT'});
			}

			if (request.method() === 'PUT' && body && body.password !== undefined) {
				if (String(body.password).length < 6) {
					return this.json(route, 422, {code: 'weak_password', error_code: 'weak_password', msg: 'Password should be at least 6 characters.'});
				}

				if (this.passwords.get(caller.id) === body.password) {
					return this.json(route, 422, {code: 'same_password', error_code: 'same_password', msg: 'New password should be different from the old password.'});
				}

				this.passwords.set(caller.id, body.password);
			}

			return this.json(route, 200, caller);
		}

		if (path === '/logout') {
			return route.fulfill({headers: this.cors(), status: 204});
		}

		return this.json(route, 404, {msg: `No fake for ${path}`});
	}

	// ------------------------------------------------------------- realtime

	// The Phoenix protocol supabase-js speaks over the socket: vsn 2.0.0 sends
	// [join_ref, ref, topic, event, payload] arrays, 1.0.0 sends objects. It
	// accepts joins, heartbeats, and token updates, and sends nothing on its
	// own, like a project whose documents table is not in the
	// supabase_realtime publication. pushChange() sends what the server would
	// once it is.
	realtime(ws, device) {
		const socket = {closed: false, device, joins: new Map(), url: ws.url(), ws};

		this.sockets.push(socket);
		ws.onClose(() => {
			socket.closed = true;
		});
		ws.onMessage((raw) => {
			let message;

			try {
				message = JSON.parse(String(raw));
			}
			catch {
				return;
			}

			socket.arrays = Array.isArray(message);

			const [joinRef, ref, topic, event, payload] = socket.arrays
				? message
				: [message.join_ref, message.ref, message.topic, message.event, message.payload];
			const reply = (response) => this.wsSend(socket, [joinRef, ref, topic, 'phx_reply', {response, status: 'ok'}]);

			if (event === 'heartbeat') {
				return reply({});
			}

			if (event === 'phx_join') {
				const changes = (((payload || {}).config || {}).postgres_changes || []).map((change) => ({...change, id: ++this.changeIds}));

				socket.joins.set(topic, {caller: this.userOfToken((payload || {}).access_token), changes, joinRef});

				return reply({postgres_changes: changes});
			}

			if (event === 'access_token') {
				const join = socket.joins.get(topic);

				if (join) {
					join.caller = this.userOfToken((payload || {}).access_token) || join.caller;
				}

				return undefined;
			}

			if (event === 'phx_leave') {
				socket.joins.delete(topic);

				return reply({});
			}

			return undefined;
		});
	}

	wsSend(socket, [joinRef, ref, topic, event, payload]) {
		if (socket.closed) {
			return;
		}

		socket.ws.send(JSON.stringify(socket.arrays === false ? {event, join_ref: joinRef, payload, ref, topic} : [joinRef, ref, topic, event, payload]));
	}

	// The account an access token belongs to, or null for none, a broken
	// one, or one whose session was revoked.
	userOfToken(token) {
		const parts = String(token || '').split('.');

		if (parts.length !== 3) {
			return null;
		}

		try {
			const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

			if (payload.session_id && this.revoked.has(payload.session_id)) {
				return null;
			}

			return this.users.get(payload.sub) || null;
		}
		catch {
			return null;
		}
	}

	// Sockets still open, for a test that checks a hidden tab let go.
	openSockets(device) {
		return this.sockets.filter((socket) => !socket.closed && (!device || socket.device === device));
	}

	// A postgres_changes event for a documents row, sent to every channel
	// whose subscription matches and whose caller row-level security lets
	// read the row. The record carries user_id and updated_at only, as the
	// real server sends for a row too large for one message, unless
	// realtimeDocs is set and the row is under 1 MB: then doc comes too.
	pushChange(row, type = 'UPDATE') {
		const whole = this.realtimeDocs && JSON.stringify(row).length <= 1048576;

		for (const socket of this.sockets) {
			for (const [topic, join] of socket.joins) {
				if (!this.canRead(join.caller, row.user_id)) {
					continue;
				}

				const ids = join.changes
					.filter((change) => change.schema === 'public' && change.table === 'documents')
					.filter((change) => change.event === '*' || change.event === type)
					.filter((change) => !change.filter || change.filter === `user_id=eq.${row.user_id}`)
					.map((change) => change.id);

				if (!ids.length) {
					continue;
				}

				const record = whole ? {doc: structuredClone(row.doc), updated_at: row.updated_at, user_id: row.user_id} : {updated_at: row.updated_at, user_id: row.user_id};
				const columns = [{name: 'user_id', type: 'uuid'}, {name: 'updated_at', type: 'timestamptz'}];

				this.wsSend(socket, [null, null, topic, 'postgres_changes', {
					data: {
						columns: whole ? [{name: 'doc', type: 'jsonb'}, ...columns] : columns,
						commit_timestamp: row.updated_at,
						errors: this.realtimeDocs && !whole ? ['Error 413: Payload Too Large'] : null,
						old_record: type === 'INSERT' ? undefined : {user_id: row.user_id},
						record,
						schema: 'public',
						table: 'documents',
						type,
					},
					ids,
				}]);
			}
		}
	}

	// ------------------------------------------------------------- rest

	// entry.answered: the bytes of the rows answered, for tests that measure
	// what a read downloads.
	async rest(route, request, url, body, entry = {}) {
		const caller = this.callerOf(request);
		const path = url.pathname.slice('/rest/v1/'.length);
		const method = request.method();
		const headers = request.headers();
		const prefer = headers.prefer || '';
		const single = (headers.accept || '').includes('vnd.pgrst.object');

		if (!caller) {
			return this.json(route, 401, {code: '42501', message: 'permission denied'});
		}

		const filters = {};

		for (const [key, value] of url.searchParams) {
			if (value.startsWith('eq.')) {
				filters[key] = [value.slice(3)];
			}
			else if (value.startsWith('in.(') && value.endsWith(')')) {
				filters[key] = value.slice(4, -1).split(',').map((item) => item.trim().replace(/^"(.*)"$/, '$1'));
			}
		}

		// A column, or a JSON path in one (alias:doc->settings->favorite_pokemon,
		// named after its last key without an alias). -> gives JSON, ->> text.
		const columns = (url.searchParams.get('select') || '*').split(',').map((column) => {
			const [alias, path] = column.includes(':') ? column.trim().split(':') : [null, column.trim()];
			const keys = path.split(/->>?/);
			const text = path.includes('->>');

			return {alias: alias || keys[keys.length - 1], keys, text};
		});
		const read = (row, {keys, text}) => {
			let value = row;

			for (const key of keys) {
				value = value === null || value === undefined ? undefined : value[key];
			}

			if (value === undefined) {
				return null;
			}

			return text && value !== null && typeof value !== 'string' ? JSON.stringify(value) : value;
		};
		const pick = (row) => (columns[0].keys[0] === '*' ? row : Object.fromEntries(columns.map((column) => [column.alias, read(row, column)])));
		const rows = (list) => {
			const picked = list.map(pick);

			entry.answered = JSON.stringify(single ? picked[0] ?? null : picked).length;

			if (single) {
				return picked.length === 1
					? this.json(route, 200, picked[0])
					: this.json(route, 406, {code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned'});
			}

			return this.json(route, method === 'POST' ? 201 : 200, picked);
		};
		const matches = (row) => Object.entries(filters).every(([key, values]) => values.includes(String(row[key])));

		if (path.startsWith('rpc/')) {
			return this.rpc(route, caller, path.slice(4), body || {});
		}

		if (path === 'documents') {
			const visible = [...this.documents.values()].filter((row) => this.canRead(caller, row.user_id));

			if (method === 'GET') {
				return rows(visible.filter(matches));
			}

			if (method === 'POST') {
				if (body.user_id !== caller.id) {
					return this.json(route, 403, {code: '42501', message: 'new row violates row-level security policy for table "documents"'});
				}

				if (this.documents.has(body.user_id)) {
					return this.json(route, 409, {code: '23505', message: 'duplicate key value violates unique constraint "documents_pkey"'});
				}

				const row = {doc: structuredClone(body.doc), updated_at: this.now(), user_id: body.user_id};

				this.documents.set(row.user_id, row);

				return rows([row]);
			}

			if (method === 'PATCH') {
				const hit = visible.filter((row) => row.user_id === caller.id).filter(matches);

				for (const row of hit) {
					row.doc = structuredClone(body.doc);
					row.updated_at = this.now();
				}

				return rows(hit);
			}
		}

		if (path === 'profiles') {
			if (method === 'GET') {
				return rows([...this.profiles.values()].filter((row) => this.canRead(caller, row.user_id)).filter(matches));
			}

			if (method === 'POST') {
				if (body.user_id !== caller.id) {
					return this.json(route, 403, {code: '42501', message: 'row-level security'});
				}

				const existing = this.profiles.get(body.user_id);

				if (existing && prefer.includes('ignore-duplicates')) {
					return route.fulfill({headers: this.cors(), status: 201});
				}

				this.profiles.set(body.user_id, {created_at: existing ? existing.created_at : this.now(), ...existing, ...body});

				return route.fulfill({headers: this.cors(), status: 201});
			}
		}

		return this.json(route, 404, {code: 'PGRST205', message: `No fake for ${method} ${path}`});
	}

	rpc(route, caller, name, args) {
		const ownerGroup = () => {
			const member = this.members.find((row) => row.user_id === caller.id && row.role === 'owner');

			return member ? member.group_id : null;
		};
		const fail = (code, message) => this.json(route, 400, {code, details: null, hint: null, message});

		if (name === 'claim_owner') {
			let created = false;

			if (!this.groups.length) {
				const group = {id: randomUUID(), name: args.group_name || 'Family', owner_id: caller.id};

				this.groups.push(group);
				this.members.push({group_id: group.id, role: 'owner', user_id: caller.id});
				created = true;
			}

			const group = this.groups[0];
			const me = this.members.find((row) => row.group_id === group.id && row.user_id === caller.id);

			return this.json(route, 200, {created, group_id: me ? group.id : null, group_name: me ? group.name : null, role: me ? me.role : null});
		}

		if (name === 'add_member') {
			const group = ownerGroup();

			if (!group) {
				return fail('42501', 'Only the family owner can add members.');
			}

			const target = this.userByEmail(String(args.email).trim());

			if (!target) {
				return fail('P0002', `No account uses ${String(args.email).trim()} yet. Invite them first in the Supabase dashboard (Authentication, Users, Invite), then add them here.`);
			}

			if (!this.members.some((row) => row.group_id === group && row.user_id === target.id)) {
				this.members.push({group_id: group, role: 'member', user_id: target.id});
			}

			return this.json(route, 200, {group_id: group, user_id: target.id});
		}

		if (name === 'remove_member') {
			const group = ownerGroup();

			if (!group) {
				return fail('42501', 'Only the family owner can remove members.');
			}

			if (args.user_id === caller.id) {
				return fail('42501', 'The owner cannot remove themselves.');
			}

			const index = this.members.findIndex((row) => row.group_id === group && row.user_id === args.user_id && row.role === 'member');

			if (index < 0) {
				return fail('P0002', 'That person is not a member of your family group.');
			}

			this.members.splice(index, 1);

			return this.json(route, 200, {group_id: group, user_id: args.user_id});
		}

		if (name === 'group_overview') {
			const mine = this.members.find((row) => row.user_id === caller.id);

			if (!mine) {
				return this.json(route, 200, {group: null, members: [], role: null});
			}

			const group = this.groups.find((row) => row.id === mine.group_id);
			const members = this.members
				.filter((row) => row.group_id === group.id)
				.map((row) => ({
					display_name: (this.profiles.get(row.user_id) || {}).display_name || null,
					email: this.users.get(row.user_id).email,
					role: row.role,
					user_id: row.user_id,
				}))
				.sort((a, b) => (b.role === 'owner') - (a.role === 'owner'));

			return this.json(route, 200, {group, members, role: mine.role});
		}

		return this.json(route, 404, {code: 'PGRST202', message: `Could not find the function public.${name}`});
	}
}
