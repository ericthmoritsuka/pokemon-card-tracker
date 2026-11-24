// Unit tests for taking a favorite off HOTARU (js/store-publish.js
// withdrawListings and withdrawNoticeText; Eric, 2026-11-24): what the card
// page says when supabase/store-withdraw.sql has not been run yet, when the
// caller is not the shop owner, and on any other failure. The SQL itself is
// checked by tests/store-withdraw-sql-check.sh. Plain Node; nothing leaves
// the machine.
//
// Run: node --test tests/store-withdraw.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/dom.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

const {withdrawListings, withdrawNoticeText} = await import('../js/store-publish.js');

describe('withdrawNoticeText', () => {
	test('before store-withdraw.sql is run, the Shop\'s next publish is the safety net', () => {
		const later = 'Starred. It leaves HOTARU the next time you open the Shop online.';

		assert.equal(withdrawNoticeText({code: 'PGRST202', message: 'Could not find the function public.store_withdraw(ids) in the schema cache'}), later);
		assert.equal(withdrawNoticeText({code: '42883', message: 'function public.store_withdraw(text[]) does not exist'}), later);
		assert.equal(withdrawNoticeText({message: 'store_withdraw is missing'}), later);
	});

	test('a caller who is not the shop owner is told so', () => {
		assert.equal(withdrawNoticeText({code: '42501', message: 'Only the shop owner can withdraw.'}), 'Starred. Only the shop owner can take it off HOTARU.');
	});

	test('any other failure says it was not taken off yet, with the reason', () => {
		assert.equal(withdrawNoticeText({message: 'Failed to fetch'}), 'Starred, but it could not be taken off HOTARU yet. It leaves the next time you open the Shop online. Failed to fetch');
		assert.equal(withdrawNoticeText(null), 'Starred, but it could not be taken off HOTARU yet. It leaves the next time you open the Shop online.');
	});
});

describe('withdrawListings', () => {
	test('no copies asks nothing of the server', async () => {
		assert.deepEqual(await withdrawListings([]), []);
		assert.deepEqual(await withdrawListings(null), []);
	});
});
