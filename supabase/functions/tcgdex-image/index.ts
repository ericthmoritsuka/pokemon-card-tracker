// tcgdex-image: hands one TCGdex card picture to Save image on card detail
// (js/photos/save.js), for a signed-in person.
//
// Why it exists: assets.tcgdex.net sends Access-Control-Allow-Origin twice
// on most card images (js/image-folders.js), and a browser refuses a cors
// read whose header is doubled. On 2026-11-11, 32 of 48 sampled cards failed
// for both their PNG and their WebP, and a request that skipped the CDN's
// copies failed every time, so the app cannot read them itself. This
// function fetches the picture server side, where no CORS applies, and
// answers with the header once.
//
// It fetches nothing but https://assets.tcgdex.net/<path>/high.png or
// high.webp, so it is not a proxy for anything else, and it answers only a
// signed-in person, checked with Supabase Auth itself (the project's
// publishable key is not a JWT, so the gateway's own JWT check stays off for
// this function; README.md, Setup, says how to deploy it).
//
// GET /functions/v1/tcgdex-image?path=en/sv/sv08/057/high.png
//   headers: Authorization: Bearer <the person's access token>, apikey
//   200 the image (image/png or image/webp), 400 a path that is not a card
//   picture, 401 not signed in, 404 TCGdex has no such picture, 502 TCGdex
//   failed.

const HOST = 'https://assets.tcgdex.net';

// <language>/<series>/<set>/<number>/high.(png|webp), as js/catalog.js
// cardImage builds it from TCGdex's image field; a language such as zh-tw
// has a region. Anything else is refused, and Save image opens a tab.
const CARD_IMAGE = /^\/[a-z]{2}(?:-[a-z]{2})?\/(?:[^/]+\/){3}high\.(?:png|webp)$/;

const CORS = {
	'Access-Control-Allow-Headers': 'apikey, authorization, x-client-info',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Origin': '*',
};

const answer = (status: number, message: string) =>
	new Response(message, {headers: {...CORS, 'Content-Type': 'text/plain; charset=utf-8'}, status});

// The picture's address, or null for anything else: a path resolved
// against the host can still leave it ("//elsewhere/x") or climb out of a
// folder (".."), so the check runs on the resolved address.
function cardImageUrl(path: string): URL | null {
	try {
		const url = new URL(path, `${HOST}/`);

		return url.origin === HOST && !url.search && !url.hash && CARD_IMAGE.test(url.pathname) ? url : null;
	}
	catch {
		return null;
	}
}

async function signedIn(request: Request): Promise<boolean> {
	const authorization = request.headers.get('authorization') || '';
	const apikey = request.headers.get('apikey') || '';

	if (!/^Bearer \S+$/.test(authorization) || !apikey) {
		return false;
	}

	const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {headers: {apikey, authorization}});

	return response.ok;
}

Deno.serve(async (request) => {
	if (request.method === 'OPTIONS') {
		return new Response(null, {headers: CORS, status: 204});
	}

	if (request.method !== 'GET') {
		return answer(405, 'Only GET.');
	}

	const url = cardImageUrl(new URL(request.url).searchParams.get('path') || '');

	if (!url) {
		return answer(400, 'Not a TCGdex card picture.');
	}

	if (!(await signedIn(request))) {
		return answer(401, 'Sign in first.');
	}

	let upstream: Response;

	try {
		upstream = await fetch(url);
	}
	catch {
		return answer(502, 'TCGdex did not answer.');
	}

	const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();

	if (upstream.status === 404) {
		return answer(404, 'TCGdex has no such picture.');
	}

	if (!upstream.ok || !/^image\/(?:png|webp)$/.test(type)) {
		return answer(502, 'TCGdex did not send the picture.');
	}

	return new Response(upstream.body, {
		headers: {...CORS, 'Cache-Control': 'private, max-age=86400', 'Content-Type': type},
		status: 200,
	});
});
