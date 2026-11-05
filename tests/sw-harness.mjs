// Runs the real sw.js in Node for its image caching (tests/image-worker.test.mjs):
// a fake service worker global with Cache Storage in memory (keys in the
// order they were put, a put again moving one to the end, as in Chrome), a
// scripted network, and a clock the test moves by hand. Each startWorker()
// is a new worker over the same storage, as when the phone stops the worker
// and starts it again. No browser, no network.

import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url);

export const SCOPE = 'https://ericthmoritsuka.github.io/pokemon-card-tracker/';

// A response as fetch gives it: cors (readable), opaque (no-cors: status 0,
// ok false), or an error status.
function response(type, status, body = '') {
	return {
		body,
		ok: status >= 200 && status < 300,
		status,
		type,
		clone() {
			return response(type, status, body);
		},
		async json() {
			return JSON.parse(body);
		},
		async text() {
			return body;
		},
	};
}

export const cors = (status = 200) => response('cors', status, 'image');
export const opaque = () => response('opaque', 0);

// The caches, shared by every worker started over them.
export function makeStorage() {
	const stores = new Map();
	const keyOf = (request) => (typeof request === 'string' ? request : request.url);

	const open = (name) => {
		if (!stores.has(name)) {
			stores.set(name, new Map());
		}

		const entries = stores.get(name);

		return {
			async delete(request) {
				return entries.delete(keyOf(request));
			},
			async keys() {
				return [...entries.keys()].map((url) => ({url}));
			},
			async match(request) {
				const hit = entries.get(keyOf(request));

				return hit ? hit.clone() : undefined;
			},
			async put(request, value) {
				const key = keyOf(request);
				// A Response the worker made (the saved memory) is kept as text.
				const kept = value instanceof Response ? response('default', value.status, await value.text()) : value.clone();

				entries.delete(key);
				entries.set(key, kept);
			},
		};
	};

	return {
		caches: {
			async delete(name) {
				return stores.delete(name);
			},
			async keys() {
				return [...stores.keys()];
			},
			async match(request, {cacheName} = {}) {
				for (const name of cacheName ? [cacheName] : [...stores.keys()]) {
					if (stores.has(name)) {
						const hit = await open(name).match(request);

						if (hit) {
							return hit;
						}
					}
				}

				return undefined;
			},
			async open(name) {
				return open(name);
			},
		},
		// The URLs kept in one cache, in trim order.
		urls: (name) => [...(stores.get(name) || new Map()).keys()],
		// The worker's saved image memory, or null.
		async memory() {
			const hit = await this.caches.match(`${SCOPE}image-folders.json`, {cacheName: 'card-tracker-image-folders'});

			return hit ? hit.json() : null;
		},
	};
}

// A clock for the worker's Date.
export function makeClock(start = Date.UTC(2026, 10, 5, 12)) {
	return {now: start};
}

// Starts sw.js over `storage`. network(url, init) answers each fetch: a
// response, or throws as a failed fetch does. Every fetch is logged as
// {cache, mode, url}; inFlight and maxInFlight count the fetches not
// answered yet.
export function startWorker(storage, network, {clock = makeClock(), online = true, quota = 10 * 1024 ** 3} = {}) {
	const listeners = {};
	const log = [];
	const counts = {inFlight: 0, maxInFlight: 0};
	const RealDate = Date;

	class WorkerDate extends RealDate {
		constructor(...args) {
			super(...(args.length ? args : [clock.now]));
		}

		static now() {
			return clock.now;
		}
	}

	const navigator = {onLine: online, storage: {estimate: async () => ({quota, usage: 0})}};
	const context = {
		Array, Boolean, JSON, Map, Math, Number, Object, Promise, Request, Response, Set, String, URL,
		Date: WorkerDate,
		addEventListener: (type, listener) => {
			listeners[type] = listener;
		},
		caches: storage.caches,
		clients: {claim: async () => {}},
		console,
		async fetch(input, init = {}) {
			const url = String(input && input.url ? input.url : input);

			log.push({cache: init.cache || 'default', mode: init.mode || 'cors', url});
			counts.inFlight++;
			counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);

			try {
				// A turn of the event loop, so fetches made together overlap.
				await new Promise((resolve) => setTimeout(resolve, 1));

				return await network(url, init);
			}
			finally {
				counts.inFlight--;
			}
		},
		location: new URL('sw.js', SCOPE),
		navigator,
		registration: {scope: SCOPE},
		skipWaiting() {},
	};

	context.self = context;
	context.globalThis = context;
	context.importScripts = (path) => vm.runInContext(readFileSync(new URL(path, ROOT), 'utf8'), context);
	vm.createContext(context);
	vm.runInContext(readFileSync(new URL('sw.js', ROOT), 'utf8'), context);

	// One fetch event from the page for `url`; resolves with the response
	// once the work it kept going (event.waitUntil) is done too.
	async function show(url) {
		const pending = [];
		let answer = null;

		listeners.fetch({
			request: {method: 'GET', mode: 'no-cors', url},
			respondWith(promise) {
				answer = promise;
			},
			waitUntil(promise) {
				pending.push(promise);
			},
		});

		const result = await answer;

		for (let i = 0; i < pending.length; i++) {
			await pending[i];
		}

		return result;
	}

	return {counts, log, navigator, show};
}
