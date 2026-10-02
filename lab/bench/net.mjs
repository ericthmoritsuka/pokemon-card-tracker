// Record and replay for TCGdex and PokeAPI: every answer is kept in the
// cache folder (outside the repo), keyed by method, URL, and body, so a
// rerun needs no network and measures the scanner, not the connection. The
// card images the benchmark degrades are fetched here too (cardImage).

import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const exists = (path) => stat(path).then(() => true, () => false);

export async function routeNet(context, cache, counts = {api: 0, fetched: 0, images: 0}) {
	const dir = join(cache, 'net');

	await mkdir(dir, {recursive: true});

	const answer = async (route, kind) => {
		const request = route.request();
		const url = request.url();
		const body = request.postData() || '';
		const key = createHash('sha1').update(`${request.method()} ${url} ${body}`).digest('hex');
		const file = join(dir, key);

		counts[kind]++;

		if (await exists(`${file}.json`)) {
			const meta = JSON.parse(await readFile(`${file}.json`, 'utf8'));

			return route.fulfill({body: await readFile(file), contentType: meta.contentType, headers: {'access-control-allow-origin': '*'}, status: meta.status});
		}

		let response;

		try {
			response = await fetch(url, {body: request.method() === 'POST' ? body : undefined, headers: request.method() === 'POST' ? {'content-type': 'application/json'} : {}, method: request.method()});
		}
		catch {
			return route.abort('internetdisconnected');
		}

		counts.fetched++;

		const data = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get('content-type') || 'application/octet-stream';

		if (response.status < 500) {
			await writeFile(file, data);
			await writeFile(`${file}.json`, JSON.stringify({contentType, status: response.status, url}));
		}

		return route.fulfill({body: data, contentType, headers: {'access-control-allow-origin': '*'}, status: response.status});
	};

	await context.route('https://api.tcgdex.net/**', (route) => answer(route, 'api'));
	await context.route('https://assets.tcgdex.net/**', (route) => answer(route, 'images'));
	await context.route(/https:\/\/(graphql\.)?pokeapi\.co\/.*/, (route) => answer(route, 'api'));
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	return counts;
}

// A card's TCGdex scan (high.webp, 600 x 825) in its own language, fetched
// once into the cache. Returns the path under /cache/ the page loads.
export async function cardImage(cache, {id, lang}) {
	const dir = join(cache, 'images');
	const name = `${lang}-${id}.webp`;

	await mkdir(dir, {recursive: true});

	if (!(await exists(join(dir, name)))) {
		const card = await (await fetch(`https://api.tcgdex.net/v2/${lang}/cards/${encodeURIComponent(id)}`)).json();

		if (!card.image) {
			throw new Error(`TCGdex has no ${lang} image for ${id}.`);
		}

		const response = await fetch(`${card.image}/high.webp`);

		if (!response.ok) {
			throw new Error(`TCGdex did not serve ${lang} ${id}'s image (${response.status}).`);
		}

		await writeFile(join(dir, name), Buffer.from(await response.arrayBuffer()));
	}

	return `/cache/images/${name}`;
}
