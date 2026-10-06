// Recorded TCGdex answers for the browser checks of the catalog views
// (tests/app.test.mjs, tests/themes-app.test.mjs), so no test reaches the
// real API (E-38): an outage or a data change at TCGdex no longer fails the
// release gate.
//
// replayTcgdex(context) answers every api.tcgdex.net request from
// tests/tcgdex-fixtures.json, keyed by method, path, and query (and a POST's
// body); a request not recorded gets the 404 the other fakes send, and is
// listed in the returned `missing`. Card images and logos are answered 404,
// as in the faked tests.
//
// Record again (the only time the real API is read):
//   TCGDEX_RECORD=1 PLAYWRIGHT=... node --test tests/app.test.mjs tests/themes-app.test.mjs
// Each answer TCGdex sends is merged into the fixture file as it arrives.

import {readFileSync, writeFileSync} from 'node:fs';

const FILE = new URL('./tcgdex-fixtures.json', import.meta.url);

const recording = process.env.TCGDEX_RECORD === '1';

let fixtures = null;

const load = () => {
	if (!fixtures) {
		try {
			fixtures = JSON.parse(readFileSync(FILE, 'utf8'));
		}
		catch {
			fixtures = {};
		}
	}

	return fixtures;
};

const keyOf = (request) => {
	const target = new URL(request.url());
	const body = request.method() === 'POST' ? ` ${request.postData() || ''}` : '';

	return `${request.method()} ${target.pathname}${target.search}${body}`;
};

export async function replayTcgdex(context) {
	const missing = [];

	if (recording) {
		// What else leaves the machine, for whoever records to fake too.
		context.on('request', (request) => {
			const {hostname} = new URL(request.url());

			if (!['localhost', '127.0.0.1', 'api.tcgdex.net', 'assets.tcgdex.net'].includes(hostname)) {
				console.error(`outside request: ${request.url()}`);
			}
		});
	}

	await context.route('https://api.tcgdex.net/**', async (route) => {
		const request = route.request();
		const key = keyOf(request);

		if (recording) {
			const response = await route.fetch();
			const text = await response.text();

			try {
				load()[key] = {body: JSON.parse(text), status: response.status()};
				writeFileSync(FILE, `${JSON.stringify(Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b))), null, '\t')}\n`);
			}
			catch {
				// Not JSON: not kept.
			}

			return route.fulfill({body: text, contentType: 'application/json', status: response.status()});
		}

		const hit = load()[key];

		if (!hit) {
			missing.push(key);

			return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
		}

		return route.fulfill({body: JSON.stringify(hit.body), contentType: 'application/json', status: hit.status});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));

	return {missing};
}
