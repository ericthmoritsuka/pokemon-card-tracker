// tests/fake-supabase.mjs plus Supabase Storage for the card-photos bucket,
// with the rules supabase/photos.sql sets: a person writes and deletes only
// under their own <user_id>/ folder, in the one path shape, and reads their
// own photos and their family group's. Only the endpoints supabase-js uses
// for upload, download, and remove are imitated.
//
// `offline = true` makes every request to the project fail as a phone with
// no signal would (the request never reaches the server), and counts them in
// offlineAttempts.

import {randomUUID} from 'node:crypto';

import {FakeSupabase, PUBLISHABLE_KEY, SUPABASE_ORIGIN} from './fake-supabase.mjs';

export {SUPABASE_ORIGIN};

const BUCKET = 'card-photos';
const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.(webp|jpg)$/;
const TYPES = new Set(['image/webp', 'image/jpeg']);
const LIMIT = 524288;

export class FakeStorageSupabase extends FakeSupabase {
	constructor(options) {
		super(options);
		this.objects = new Map();
		this.offline = false;
		this.offlineAttempts = [];
		this.refuse = null;
	}

	async handle(route, device) {
		const request = route.request();
		const url = new URL(request.url());

		if (this.offline) {
			this.offlineAttempts.push({method: request.method(), path: url.pathname});

			return route.abort('internetdisconnected');
		}

		if (url.pathname.startsWith('/storage/v1/')) {
			return this.storage(route, request, url, device);
		}

		return super.handle(route, device);
	}

	storageLog(kind) {
		return this.log.filter((entry) => entry.storage === kind);
	}

	fail(route, status, error, message) {
		return this.json(route, status, {error, message, statusCode: String(status)});
	}

	async storage(route, request, url, device) {
		const method = request.method();

		if (method === 'OPTIONS') {
			return route.fulfill({headers: this.cors(), status: 204});
		}

		const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length)).replace(/^authenticated\//, '');
		const [bucket, ...parts] = rest.split('/');
		const path = parts.join('/');
		const body = request.postDataBuffer();
		const kind = method === 'POST' || method === 'PUT' ? 'upload' : method === 'GET' ? 'download' : method === 'DELETE' ? 'remove' : method;

		this.log.push({bytes: body ? body.length : 0, device, method, path: url.pathname, storage: kind});

		if (request.headers().apikey !== PUBLISHABLE_KEY) {
			return this.json(route, 401, {message: 'No API key found in request'});
		}

		const caller = this.callerOf(request);

		if (!caller) {
			return this.fail(route, 403, 'Unauthorized', 'Invalid JWT');
		}

		if (bucket !== BUCKET) {
			return this.fail(route, 404, 'Bucket not found', 'Bucket not found');
		}

		// A test's refusal: {status, error, message, once}. once answers only
		// the next upload that way.
		if (kind === 'upload' && this.refuse) {
			const {error, message, once, status} = this.refuse;

			if (once) {
				this.refuse = null;
			}

			return this.fail(route, status, error, message);
		}

		if (kind === 'upload') {
			const headers = request.headers();
			const upsert = headers['x-upsert'] === 'true';
			const type = (headers['content-type'] || '').split(';')[0];

			if (!PATH.test(path) || path.split('/')[0] !== caller.id) {
				return this.fail(route, 403, 'Unauthorized', 'new row violates row-level security policy');
			}

			if (!TYPES.has(type)) {
				return this.fail(route, 415, 'invalid_mime_type', `mime type ${type} is not supported`);
			}

			if (!body || body.length > LIMIT) {
				return this.fail(route, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
			}

			if (this.objects.has(path) && !upsert) {
				return this.fail(route, 409, 'Duplicate', 'The resource already exists');
			}

			this.objects.set(path, {bytes: Buffer.from(body), contentType: type, owner: caller.id});

			return this.json(route, 200, {Id: randomUUID(), Key: `${BUCKET}/${path}`});
		}

		if (kind === 'download') {
			const object = this.objects.get(path);

			if (!object || !this.canRead(caller, object.owner)) {
				return this.fail(route, 404, 'not_found', 'Object not found');
			}

			return route.fulfill({body: object.bytes, contentType: object.contentType, headers: this.cors(), status: 200});
		}

		if (kind === 'remove') {
			let prefixes = [];

			try {
				prefixes = JSON.parse(request.postData() || '{}').prefixes || [];
			}
			catch {
				prefixes = [];
			}

			const removed = [];

			for (const name of prefixes) {
				const object = this.objects.get(name);

				if (object && object.owner === caller.id) {
					this.objects.delete(name);
					removed.push({bucket_id: BUCKET, name});
				}
			}

			return this.json(route, 200, removed);
		}

		return this.fail(route, 405, 'Method not allowed', `No fake for ${method}`);
	}
}
