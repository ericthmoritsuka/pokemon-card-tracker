// Keeps the phone's document merged with the signed-in person's documents
// row in Supabase (DESIGN.md sections 3 and 8). Local first: every edit is
// saved on the phone at once, and this module pushes it when there is signal.
//
// One sync:
//   1. Read the row's updated_at, which the server sets on every write
//      (supabase/setup.sql). If it is still the value this phone last saw,
//      the server holds nothing new, so the full row is not downloaded.
//      Otherwise read the whole row and merge it in, entry by entry
//      (js/merge.js).
//   2. When the merged document holds anything the server lacks, write it
//      with a compare-and-set guard: update only where updated_at still
//      equals the value read in step 1. If another device wrote in between,
//      the update matches no row, so this phone reads again, merges again,
//      and retries. Nothing either device added is lost, because each retry
//      merges the other device's entries in before writing.
//   3. Merge the result into the phone's document. An edit made while the
//      sync was on the network is newer, so it wins and is pushed next.
//
// After an edit the push waits a few seconds, so a burst of edits goes up as
// one write. Offline, edits wait on the phone; the sync runs again when the
// connection returns, when the app is opened or brought back to the front,
// and after a failure.

import {currentUser, getClient, onUser} from './auth.js';
import {loadDocument, mergeIntoLocal, onChange, readMeta, useAccount, writeMeta} from './collection.js';
import {countChanged, mergeDocuments, sameContent, stamps} from './merge.js';

const PUSH_DELAY_MS = 3000;
const RETRY_DELAY_MS = 30000;
const MAX_ATTEMPTS = 5;
const GROUP_NAME = 'Family';

const status = {error: null, pending: 0, phase: 'off', signedIn: false};
const statusListeners = new Set();

let base = null;
let known = null;
let pushTimer = null;
let retryTimer = null;
let running = null;
let again = false;
let started = null;
let claimedFor = null;
let claimError = null;

function emit() {
	statusListeners.forEach((listener) => listener({...status}));
}

// listener({phase, pending, error, signedIn}) runs now and on every change.
// phase: off (signed out), synced, saving, offline, error.
export function onSyncStatus(listener) {
	statusListeners.add(listener);
	listener({...status});

	return () => statusListeners.delete(listener);
}

export const syncStatus = () => ({...status});

export function statusText({pending, phase}) {
	const waiting = `${pending.toLocaleString('en-US')} ${pending === 1 ? 'change' : 'changes'} waiting`;

	if (phase === 'offline') {
		return pending ? `Offline, ${waiting}` : 'Offline';
	}

	if (phase === 'saving') {
		return 'Saving';
	}

	if (phase === 'error') {
		return pending ? `Not saved, ${waiting}` : 'Not synced';
	}

	return phase === 'synced' ? 'Synced' : '';
}

function setPhase(phase, error = null) {
	status.phase = phase;
	status.error = error;
	emit();
}

async function refreshPending() {
	status.pending = countChanged(await loadDocument(), base);
}

const metaKey = (userId) => `sync:${userId}`;

async function remember(userId, serverDoc, updatedAt) {
	base = stamps(serverDoc);
	known = updatedAt;
	await writeMeta(metaKey(userId), {base: [...base], updated_at: updatedAt});
}

// What goes to the server: the document without the phone's own fields.
function outgoing(doc) {
	const copy = structuredClone(doc);

	delete copy.person;
	delete copy.user_id;

	return copy;
}

// True when every entry the server held at the last sync is still on the
// phone, so the phone's document can stand in for the server's.
function holdsBase(doc) {
	if (!base) {
		return false;
	}

	const have = stamps(doc);

	for (const key of base.keys()) {
		if (!have.has(key)) {
			return false;
		}
	}

	return true;
}

async function syncOnce() {
	const user = currentUser();

	if (!user) {
		return;
	}

	if (!navigator.onLine) {
		await refreshPending();
		setPhase('offline');

		return;
	}

	await refreshPending();

	if (status.pending) {
		setPhase('saving');
	}

	const client = await getClient();
	const table = () => client.from('documents');

	if (claimedFor !== user.id) {
		try {
			await claim(client, user);
		}
		catch (err) {
			claimError = err;
		}
	}

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const local = structuredClone(await loadDocument());
		const head = await table().select('updated_at').eq('user_id', user.id).maybeSingle();

		if (head.error) {
			throw head.error;
		}

		let remote = null;
		let stamp = head.data ? head.data.updated_at : null;

		if (stamp && !(stamp === known && holdsBase(local))) {
			const full = await table().select('doc, updated_at').eq('user_id', user.id).maybeSingle();

			if (full.error) {
				throw full.error;
			}

			if (full.data) {
				remote = full.data.doc;
				stamp = full.data.updated_at;
			}
			else {
				stamp = null;
			}
		}

		const merged = remote ? mergeDocuments(local, remote) : local;

		// Without a fresh read, the server still holds what the last sync
		// left there, whose stamps are `base`.
		const changed = remote ? !sameContent(merged, remote) : countChanged(merged, base) > 0;

		if (!stamp) {
			// No row yet: the first sync uploads the whole document.
			const insert = await table().insert({doc: outgoing(merged), user_id: user.id}).select('updated_at').single();

			if (insert.error) {
				// 23505: another device made the row first. Read it and merge.
				if (insert.error.code === '23505') {
					known = null;
					continue;
				}

				throw insert.error;
			}

			stamp = insert.data.updated_at;
		}
		else if (changed) {
			const update = await table()
				.update({doc: outgoing(merged)})
				.eq('user_id', user.id)
				.eq('updated_at', stamp)
				.select('updated_at');

			if (update.error) {
				throw update.error;
			}

			if (!update.data.length) {
				// Another device wrote since the read. Read again and merge.
				known = null;
				continue;
			}

			stamp = update.data[0].updated_at;
		}

		if (!currentUser() || currentUser().id !== user.id) {
			return;
		}

		await remember(user.id, merged, stamp);
		await mergeIntoLocal(merged);
		await refreshPending();

		if (status.pending) {
			setPhase('saving');
			schedulePush();
		}
		else {
			setPhase('synced');
		}

		return;
	}

	throw new Error('Another device kept saving at the same moment. Your changes are kept on this phone and are saved on the next try.');
}

// Runs one sync at a time; a request during a sync runs another after it.
export function syncNow() {
	clearTimeout(pushTimer);
	pushTimer = null;

	if (running) {
		again = true;

		return running;
	}

	running = (async () => {
		try {
			do {
				again = false;
				clearTimeout(retryTimer);

				try {
					await syncOnce();
				}
				catch (err) {
					await refreshPending();
					setPhase(navigator.onLine ? 'error' : 'offline', err);
					retryTimer = setTimeout(() => syncNow(), RETRY_DELAY_MS);
				}
			} while (again && currentUser());
		}
		finally {
			running = null;
		}
	})();

	return running;
}

function schedulePush() {
	clearTimeout(pushTimer);
	pushTimer = setTimeout(() => syncNow(), PUSH_DELAY_MS);
}

// The steps that run once per sign-in on this phone: tie the document to the
// account, make sure the family group and the profile row exist, then sync.
async function begin(user) {
	status.signedIn = true;
	setPhase(navigator.onLine ? 'saving' : 'offline');

	await useAccount(user.id);

	const saved = await readMeta(metaKey(user.id));

	base = saved ? new Map(saved.base) : null;
	known = saved ? saved.updated_at : null;
	await refreshPending();
	emit();

	await syncNow();
}

// Once per sign-in: the first person ever becomes the family owner, and
// everyone gets a profile row. Both are no-ops after the first time. A
// failure is retried on the next sync; the sync itself goes on.
async function claim(client, user) {
	const owner = await client.rpc('claim_owner', {group_name: GROUP_NAME});

	if (owner.error) {
		throw owner.error;
	}

	const profile = await client.from('profiles').upsert({display_name: null, user_id: user.id}, {ignoreDuplicates: true, onConflict: 'user_id'});

	if (profile.error) {
		throw profile.error;
	}

	claimedFor = user.id;
	claimError = null;
	overviewPromise = null;
}

// Why the family group or profile could not be set up, for Profile.
export const setupError = () => claimError;

function handleUser(user) {
	clearTimeout(pushTimer);
	clearTimeout(retryTimer);

	if (!user) {
		started = null;
		claimedFor = null;
		base = null;
		known = null;
		status.signedIn = false;
		status.pending = 0;
		setPhase('off');

		return;
	}

	if (started !== user.id) {
		started = user.id;
		begin(user).catch((err) => setPhase('error', err));
	}
}

// Entries waiting on this phone for the server, for the sign-out warning.
export async function pendingChanges() {
	await refreshPending();

	return status.pending;
}

export function startSync() {
	onUser(handleUser);

	onChange((doc, {source}) => {
		if (source !== 'local' || !currentUser()) {
			return;
		}

		status.pending = countChanged(doc, base);

		if (navigator.onLine) {
			setPhase('saving');
			schedulePush();
		}
		else {
			setPhase('offline');
		}
	});

	window.addEventListener('online', () => currentUser() && syncNow());
	window.addEventListener('offline', () => {
		if (currentUser()) {
			setPhase('offline');
		}
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && currentUser()) {
			syncNow();
		}
	});

	if (currentUser()) {
		handleUser(currentUser());
	}
}

// ------------------------------------------------------------ the family

// The caller's family group and its members (supabase/setup.sql,
// group_overview). Kept for this visit so the header and My Cards do not ask
// on every render.
let overviewPromise = null;

export function familyOverview({fresh = false} = {}) {
	if (!currentUser()) {
		return Promise.resolve(null);
	}

	if (!overviewPromise || fresh) {
		overviewPromise = (async () => {
			const client = await getClient();
			const {data, error} = await client.rpc('group_overview');

			if (error) {
				throw error;
			}

			return data;
		})().catch((err) => {
			overviewPromise = null;

			throw err;
		});
	}

	return overviewPromise;
}

onUser(() => {
	overviewPromise = null;
});

export async function familyCall(name, args) {
	const client = await getClient();
	const {data, error} = await client.rpc(name, args);

	if (error) {
		throw error;
	}

	overviewPromise = null;

	return data;
}

// A family member's document, read only. Row-level security returns it only
// when they share a group with the signed-in person.
export async function memberDocument(userId) {
	const client = await getClient();
	const {data, error} = await client.from('documents').select('doc, updated_at').eq('user_id', userId).maybeSingle();

	if (error) {
		throw error;
	}

	return data ? data.doc : null;
}

export async function updateDisplayName(name) {
	const user = currentUser();
	const client = await getClient();
	const {error} = await client.from('profiles').upsert({display_name: name || null, user_id: user.id}, {onConflict: 'user_id'});

	if (error) {
		throw error;
	}

	overviewPromise = null;
}

export async function displayName() {
	const user = currentUser();

	if (!user) {
		return null;
	}

	const client = await getClient();
	const {data, error} = await client.from('profiles').select('display_name').eq('user_id', user.id).maybeSingle();

	if (error) {
		throw error;
	}

	return data ? data.display_name : null;
}
