// A fixed exchange rate for every browser test. The app asks frankfurter.dev
// for the dollar and euro rates on every load (app.js, js/prices.js
// exchangeRates and euroRates), and a test must never reach a real service:
// call fakeRates(context) on each browser context a test makes, before its
// first page loads. tests/test-hygiene.test.mjs fails for a test file that
// makes a context without it (or without a route that answers every outside
// host).
//
// The answers have frankfurter's v2 shape, the one js/prices.js reads first.

export const FAKE_RATE = {base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877};
export const FAKE_EURO_RATE = {base: 'EUR', date: '2026-10-01', quote: 'BRL', rate: 5.8814};

export async function fakeRates(context) {
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({
		body: JSON.stringify([/base=EUR/.test(route.request().url()) ? FAKE_EURO_RATE : FAKE_RATE]),
		contentType: 'application/json',
		headers: {'Access-Control-Allow-Origin': '*'},
		status: 200,
	}));
}
