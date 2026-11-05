// tests/photos-fake-storage.mjs plus the scan-reports bucket, with the
// rules supabase/scan-reports.sql sets: a person adds files only under
// their own <user_id>/ folder, in the report name shapes, gzip or JSON, at
// most 6 MB, never replacing one; and lists, reads, and deletes only their
// own (no family reads). Only the endpoints supabase-js uses for upload,
// download, list, and remove are imitated. card-photos still answers as in
// tests/photos-fake-storage.mjs, and so do offline, refuse, and hold.
//
// noBucket = true answers as a project that has not run the script yet.

import {randomUUID} from 'node:crypto';

import {PUBLISHABLE_KEY} from './fake-supabase.mjs';
import {FakeStorageSupabase} from './photos-fake-storage.mjs';

export {SUPABASE_ORIGIN} from './photos-fake-storage.mjs';

const BUCKET = 'scan-reports';

// The same pattern as the add rule in supabase/scan-reports.sql
// (tests/scan-reports.test.mjs compares them).
export const REPORT_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9]{8}T[0-9]{6}\.[0-9]{3}Z-[0-9]{1,4}\.(meta\.json|json(\.gz)?(\.part[0-9]{1,3}of[0-9]{1,3})?)$/;
const TYPES = new Set(['application/gzip', 'application/json']);
const LIMIT = 6291456;

export class FakeReportStorage extends FakeStorageSupabase {
	constructor(options) {
		super(options);
		this.reports = new Map();
		this.noBucket = false;
	}

	reportsOf(userId) {
		return [...this.reports.entries()].filter(([path]) => path.startsWith(`${userId}/`)).map(([path, object]) => ({path, ...object}));
	}

	async storage(route, request, url, device) {
		const rest = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length)).replace(/^authenticated\//, '');
		const isList = rest === `list/${BUCKET}`;

		if (!isList && rest.split('/')[0] !== BUCKET) {
			return super.storage(route, request, url, device);
		}

		const method = request.method();

		if (method === 'OPTIONS') {
			return route.fulfill({headers: this.cors(), status: 204});
		}

		const path = isList ? '' : rest.split('/').slice(1).join('/');
		const body = request.postDataBuffer();
		const kind = isList ? 'list' : method === 'POST' || method === 'PUT' ? 'upload' : method === 'GET' ? 'download' : method === 'DELETE' ? 'remove' : method;

		this.log.push({bucket: BUCKET, bytes: body ? body.length : 0, device, method, path: url.pathname, storage: kind});

		if (request.headers().apikey !== PUBLISHABLE_KEY) {
			return this.json(route, 401, {message: 'No API key found in request'});
		}

		const caller = this.callerOf(request);

		if (!caller) {
			return this.fail(route, 403, 'Unauthorized', 'Invalid JWT');
		}

		if (this.noBucket) {
			return this.fail(route, 400, 'Bucket not found', 'Bucket not found');
		}

		if (kind === 'upload' && this.refuse) {
			const {error, message, once, status} = this.refuse;

			if (once) {
				this.refuse = null;
			}

			return this.fail(route, status, error, message);
		}

		if (kind === 'upload' && this.hold) {
			await this.hold;
		}

		if (kind === 'upload') {
			const headers = request.headers();
			const type = (headers['content-type'] || '').split(';')[0];

			if (method === 'PUT' || headers['x-upsert'] === 'true') {
				// No update rule: a replace is refused.
				return this.fail(route, 403, 'Unauthorized', 'new row violates row-level security policy');
			}

			if (!REPORT_PATH.test(path) || path.split('/')[0] !== caller.id) {
				return this.fail(route, 403, 'Unauthorized', 'new row violates row-level security policy');
			}

			if (!TYPES.has(type)) {
				return this.fail(route, 415, 'invalid_mime_type', `mime type ${type} is not supported`);
			}

			if (!body || body.length > LIMIT) {
				return this.fail(route, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
			}

			if (this.reports.has(path)) {
				return this.fail(route, 409, 'Duplicate', 'The resource already exists');
			}

			this.reports.set(path, {bytes: Buffer.from(body), contentType: type, created_at: new Date().toISOString(), owner: caller.id});

			return this.json(route, 200, {Id: randomUUID(), Key: `${BUCKET}/${path}`});
		}

		if (kind === 'download') {
			const object = this.reports.get(path);

			// Only the owner reads, family or not.
			if (!object || object.owner !== caller.id) {
				return this.fail(route, 400, 'not_found', 'Object not found');
			}

			return route.fulfill({body: object.bytes, contentType: object.contentType, headers: this.cors(), status: 200});
		}

		if (kind === 'list') {
			let options = {};

			try {
				options = JSON.parse(request.postData() || '{}');
			}
			catch {
				options = {};
			}

			const prefix = String(options.prefix || '').replace(/\/+$/, '');
			const found = [...this.reports.entries()]
				.filter(([name, object]) => object.owner === caller.id && name.startsWith(`${prefix}/`) && !name.slice(prefix.length + 1).includes('/'))
				.map(([name, object]) => ({
					created_at: object.created_at,
					id: randomUUID(),
					last_accessed_at: object.created_at,
					metadata: {mimetype: object.contentType, size: object.bytes.length},
					name: name.slice(prefix.length + 1),
					updated_at: object.created_at,
				}))
				.sort((a, b) => (options.sortBy && options.sortBy.order === 'desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));

			return this.json(route, 200, found.slice(options.offset || 0, (options.offset || 0) + (options.limit || 100)));
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
				const object = this.reports.get(name);

				if (object && object.owner === caller.id) {
					this.reports.delete(name);
					removed.push({bucket_id: BUCKET, name});
				}
			}

			return this.json(route, 200, removed);
		}

		return this.fail(route, 405, 'Method not allowed', `No fake for ${method}`);
	}
}
