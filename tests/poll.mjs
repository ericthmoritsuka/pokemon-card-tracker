// Waits from Node for a check that must await in the page, such as a
// Cache Storage, IndexedDB, or service worker read.
//
// page.waitForFunction cannot run an async check: it takes the promise the
// check returns as a true answer at once, so it neither waits nor checks.
// Give waitForFunction a synchronous check, or poll an async one here.
// tests/test-hygiene.test.mjs fails when an async check reaches
// waitForFunction again.

// A check that runs while the page navigates (a reload, a new worker taking
// over) loses its context; the next poll runs in the new page.
const NAVIGATING = /Execution context was destroyed|Cannot find context with specified id|because of a navigation/i;

// Runs `check` in the page every `interval` ms until it returns a truthy
// value, and fails naming `what` and the last answer after `timeout` ms.
export async function untilInPage(page, what, check, {arg, interval = 100, timeout = 15000} = {}) {
	const end = Date.now() + timeout;
	let last;

	for (;;) {
		try {
			last = await page.evaluate(check, arg);

			if (last) {
				return last;
			}
		}
		catch (err) {
			if (!NAVIGATING.test(err.message)) {
				throw err;
			}

			last = err.message;
		}

		if (Date.now() >= end) {
			throw new Error(`Timed out after ${timeout} ms waiting for ${what} (last answer: ${JSON.stringify(last)})`);
		}

		await page.waitForTimeout(interval);
	}
}
