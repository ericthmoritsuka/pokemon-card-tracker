// supabase/functions/tcgdex-image: the relay Save image asks when TCGdex
// refuses the app a cors read. Run under Node (which strips the types) with
// Deno.serve and fetch faked, so it never calls TCGdex or Supabase.

import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';

const PROJECT = 'https://project.test';
const IMAGE = 'https://assets.tcgdex.net/en/sv/sv08/057/high.png';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let handler = null;
let calls = [];
let answers = {};

globalThis.Deno = {
	env: {get: (name) => (name === 'SUPABASE_URL' ? PROJECT : undefined)},
	serve(fn) {
		handler = fn;
	},
};

globalThis.fetch = async (input, init = {}) => {
	const url = String(input);

	calls.push({headers: init.headers || {}, url});

	const answer = answers[url.startsWith(`${PROJECT}/auth/v1/user`) ? 'user' : url];

	if (!answer) {
		throw new TypeError('Failed to fetch');
	}

	return answer();
};

await import('../supabase/functions/tcgdex-image/index.ts');

const ask = (path, {headers = {authorization: 'Bearer token', apikey: 'sb_publishable_x'}, method = 'GET'} = {}) =>
	handler(new Request(`${PROJECT}/functions/v1/tcgdex-image?path=${encodeURIComponent(path)}`, {headers, method}));

beforeEach(() => {
	calls = [];
	answers = {
		[IMAGE]: () => new Response(PNG, {headers: {'access-control-allow-origin': '*, *', 'content-type': 'image/png'}}),
		user: () => new Response('{}', {status: 200}),
	};
});

describe('tcgdex-image', () => {
	test('a signed-in person gets the PNG, with the CORS header once', async () => {
		const response = await ask('en/sv/sv08/057/high.png');

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'image/png');
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
		assert.deepEqual(calls.map((call) => call.url), [`${PROJECT}/auth/v1/user`, IMAGE]);
		assert.deepEqual(calls[0].headers, {apikey: 'sb_publishable_x', authorization: 'Bearer token'}, 'the session is checked with the caller\'s own headers');
	});

	test('a Japanese picture and a WebP pass too', async () => {
		answers['https://assets.tcgdex.net/ja/SV/SV2a/025/high.webp'] = () => new Response(PNG, {headers: {'content-type': 'image/webp'}});

		assert.equal((await ask('ja/SV/SV2a/025/high.webp')).status, 200);
	});

	test('the preflight answers with no body and no checks', async () => {
		const response = await ask('', {headers: {}, method: 'OPTIONS'});

		assert.equal(response.status, 204);
		assert.match(response.headers.get('access-control-allow-headers'), /authorization/);
		assert.deepEqual(calls, []);
	});

	test('anything but a TCGdex card picture is refused before any fetch', async () => {
		for (const path of [
			'//elsewhere.test/a/b/c/high.png',
			'https://elsewhere.test/en/sv/sv08/057/high.png',
			'en/sv/sv08/../../../x/y/high.png',
			'en/sv/sv08/057/low.png',
			'en/sv/sv08/057/high.png?x=1',
			'en/sv/057/high.png',
			'en/sv/sv08/057/high.svg',
			'',
		]) {
			assert.equal((await ask(path)).status, 400, path);
		}

		assert.deepEqual(calls, []);
	});

	test('no session, or one Supabase refuses, gets 401 and TCGdex is never asked', async () => {
		assert.equal((await ask('en/sv/sv08/057/high.png', {headers: {apikey: 'sb_publishable_x'}})).status, 401);
		assert.deepEqual(calls, []);

		answers.user = () => new Response('{}', {status: 401});

		assert.equal((await ask('en/sv/sv08/057/high.png')).status, 401);
		assert.deepEqual(calls.map((call) => call.url), [`${PROJECT}/auth/v1/user`]);
	});

	test('a missing picture is 404; a TCGdex failure or a page that is not an image is 502', async () => {
		answers[IMAGE] = () => new Response('', {status: 404});
		assert.equal((await ask('en/sv/sv08/057/high.png')).status, 404);

		answers[IMAGE] = () => new Response('<html>', {headers: {'content-type': 'text/html'}});
		assert.equal((await ask('en/sv/sv08/057/high.png')).status, 502);

		delete answers[IMAGE];
		assert.equal((await ask('en/sv/sv08/057/high.png')).status, 502);
	});
});
