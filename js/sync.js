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
//
// While the app is open and in front, another device's save shows up here
// without a reload, two ways (the "live" section below):
//   - Supabase Realtime tells this device within seconds that its own row
//     changed. That needs the documents table in the supabase_realtime
//     publication (supabase/realtime.sql); without it the channel stays
//     silent and the poll below still works.
//   - A light poll reads only updated_at once a minute, and a sync runs when
//     the window gets focus or the tab becomes visible. A hidden tab neither
//     polls nor keeps the Realtime connection open.
// Either one only starts a sync, so a change still waiting to be pushed is
// merged with the server's, never replaced: the newer updated_at wins entry
// by entry (js/merge.js), and the merged document is what gets pushed.
// Family members' documents are read when shown, not live.

import {currentUser, getClient, onUser} from './auth.js';
import {loadDocument, mergeIntoLocal, onChange, readMeta, useAccount, writeMeta} from './collection.js';
import {countChanged, mergeDocuments, sameContent, stamps} from './merge.js';

const PUSH_DELAY_MS = 3000;
const RETRY_DELAY_MS = 30000;
const MAX_ATTEMPTS = 5;
const GROUP_NAME = 'Family';

// The poll reads one timestamp a minute while the app is in front. It never
// runs more often than every 30 seconds, however it is woken.
const POLL_MS = 60000;
const MIN_POLL_MS = 30000;

// Focus and visibilitychange usually arrive together, so a second wake this
// soon after a server check does nothing.
const WAKE_GAP_MS = 5000;

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
let lastCheck = 0;

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

		lastCheck = Date.now();

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

		// Always a merge, even with nothing new from the server: the merge
		// also repairs the document (js/merge.js folds duplicate copies), and
		// a repaired document differs from `base`, so it is pushed.
		const merged = mergeDocuments(local, remote || {});

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
			schedulePoll();
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
		refreshLive();

		return;
	}

	if (started !== user.id) {
		started = user.id;
		begin(user).catch((err) => setPhase('error', err));
	}

	refreshLive();
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

	window.addEventListener('online', () => {
		if (currentUser()) {
			syncNow();
		}

		refreshLive();
	});
	window.addEventListener('offline', () => {
		if (currentUser()) {
			setPhase('offline');
		}

		refreshLive();
	});
	document.addEventListener('visibilitychange', () => {
		refreshLive();
		wake();
	});
	window.addEventListener('focus', () => wake());

	if (currentUser()) {
		handleUser(currentUser());
	}
}

// ------------------------------------------------------------ live

let pollTimer = null;
let channel = null;
let channelUser = null;
let channelToken = null;

const inFront = () => document.visibilityState === 'visible';

// What one stamp means: the same as the last one this device saw is nothing
// new, or this device's own write coming back. Anything else starts a sync,
// which reads again and downloads the row only when it really changed. A
// stamp of undefined reads updated_at first. Waits for a running sync, which
// is what moves `known` to this device's own write.
async function checkRemote(stamp) {
	const user = currentUser();

	if (!user || !navigator.onLine) {
		return;
	}

	if (running) {
		await running;
	}

	if (stamp === undefined) {
		const client = await getClient();

		lastCheck = Date.now();

		const head = await client.from('documents').select('updated_at').eq('user_id', user.id).maybeSingle();

		// A failed check waits for the next one; it is not worth an error.
		if (head.error) {
			return;
		}

		stamp = head.data ? head.data.updated_at : null;
	}

	if (!currentUser() || currentUser().id !== user.id || stamp === known) {
		return;
	}

	await syncNow();
}

function schedulePoll() {
	clearTimeout(pollTimer);
	pollTimer = null;

	if (currentUser() && inFront()) {
		pollTimer = setTimeout(poll, Math.max(POLL_MS, MIN_POLL_MS));
	}
}

async function poll() {
	pollTimer = null;

	if (!currentUser() || !inFront()) {
		return;
	}

	if (Date.now() - lastCheck >= MIN_POLL_MS) {
		await checkRemote().catch(() => {});
	}

	if (!pollTimer && !running) {
		schedulePoll();
	}
}

// The app came to the front: sync now, unless a check has just run.
function wake() {
	if (!currentUser() || !inFront() || Date.now() - lastCheck < WAKE_GAP_MS) {
		return;
	}

	syncNow();
}

function disconnectLive() {
	const old = channel;

	channel = null;
	channelUser = null;
	channelToken = null;

	if (old) {
		// Removing the last channel closes the WebSocket.
		getClient().then((client) => client.removeChannel(old)).catch(() => {});
	}
}

// One Realtime channel on the signed-in person's own row, open only while the
// app is in front and online. A channel that fails is dropped until the next
// time the app comes to the front; the poll covers the gap.
function connectLive() {
	const user = currentUser();

	if (channelUser === user.id) {
		return;
	}

	disconnectLive();
	channelUser = user.id;

	const token = {};

	channelToken = token;

	getClient().then((client) => {
		if (channelToken !== token) {
			return;
		}

		channel = client
			.channel(`own-document:${user.id}`)
			.on('postgres_changes', {event: '*', filter: `user_id=eq.${user.id}`, schema: 'public', table: 'documents'}, (change) => {
				const stamp = change && change.new ? change.new.updated_at : undefined;

				checkRemote(stamp || undefined).catch(() => {});
			})
			.subscribe((state) => {
				if ((state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') && channelToken === token) {
					disconnectLive();
				}
			});
	}).catch(() => {
		if (channelToken === token) {
			channelUser = null;
			channelToken = null;
		}
	});
}

// Starts or stops the poll and the Realtime channel to match the moment:
// signed in and in front polls; online as well listens.
function refreshLive() {
	if (!currentUser() || !inFront()) {
		clearTimeout(pollTimer);
		pollTimer = null;
		disconnectLive();

		return;
	}

	if (!pollTimer && !running) {
		schedulePoll();
	}

	if (navigator.onLine) {
		connectLive();
	}
	else {
		disconnectLive();
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
