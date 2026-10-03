// Accounts, through Supabase Auth (DESIGN.md section 8). Sign-in is by email
// link or, when the project has it turned on, Google. Both use the PKCE flow,
// so the trip back to the app carries ?code= in the query, never a # fragment
// (iOS drops the camera permission when the hash changes).
//
// A family member with no email signs in with an account name and a
// password instead. Eric makes that account in the Supabase dashboard under
// a placeholder address at ACCOUNT_NAME_DOMAIN; .invalid is reserved (RFC
// 2606), so no mail can ever go there.
//
// The Supabase client (vendor/supabase-js.js, about 220 KB) is loaded only
// when someone has signed in on this phone or opens Sign in, so the app
// signed out stays as light as before.
//
// The project URL and the publishable key are public by design: row-level
// security on the server decides what each signed-in person can read and
// write (supabase/setup.sql).
//
// A session the server stops accepting (supabase/reset-password.sql ends an
// account's sessions; a refresh token can expire) is never a silent sign
// out. When the server refuses a request with a token that does not pass,
// the session is refreshed once; if the refresh is refused too, the session
// is over: the person stays on this phone as themselves, with their cards
// and the changes still waiting, and sessionExpired() is true until they
// sign in again (js/sync.js then shows "Sign in again" and pushes what
// waited). Only Sign out signs out.

import {BASE} from './dom.js';

export const SUPABASE_URL = 'https://ehdkbxrjxsypegbtrxbw.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_Ycfz9bobfuvHWdDKjaoQQA_LDYmm0vJ';

const STORAGE_KEY = 'card-tracker-auth';
const SETTINGS_KEY = 'cardTracker.authSettings';
const SETTINGS_FOR_MS = 10 * 60 * 1000;
// Who was signed in when the server ended the session, so a reload still
// offers "Sign in again" rather than looking signed out.
const ENDED_KEY = 'cardTracker.sessionEnded';
// When this phone last signed out on purpose, in any tab: the SIGNED_OUT
// that follows is that, not the server ending the session.
const SIGNED_OUT_KEY = 'cardTracker.signedOutAt';
const SIGNED_OUT_FOR_MS = 15 * 1000;
// One session check at a time, and not again this soon after the last.
const VERIFY_GAP_MS = 5 * 1000;

export const ACCOUNT_NAME_DOMAIN = 'family.invalid';
export const MIN_PASSWORD_LENGTH = 8;

let clientPromise = null;
let user = null;
let expired = false;
// A sign-in link or Google is coming back in this page load.
let returning = false;
let signingOut = false;
let verifying = null;
let verifiedAt = 0;

const listeners = new Set();
const sessionListeners = new Set();

// The address a sign-in link or Google sends the browser back to. Supabase
// only redirects to an address on its allow list (README.md, Setup).
export const siteUrl = () => new URL(BASE, window.location.origin).href;

export function getClient() {
	if (!clientPromise) {
		clientPromise = import('../vendor/supabase-js.js').then(({createClient}) => {
			const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
				auth: {
					autoRefreshToken: true,
					// The app reads ?code= itself, before its first render.
					detectSessionInUrl: false,
					flowType: 'pkce',
					persistSession: true,
					storageKey: STORAGE_KEY,
				},
				global: {fetch: watchedFetch},
			});

			client.auth.onAuthStateChange((event, session) => {
				// Read now: whether this SIGNED_OUT is one the person asked for.
				const deliberate = event === 'SIGNED_OUT' && (signingOut || signedOutLately());

				// Supabase asks that this callback not await its own calls, so
				// listeners run on the next turn.
				setTimeout(() => {
					if (session) {
						setUser(session.user);
						setExpired(false);
					}
					else if (event === 'SIGNED_OUT') {
						// Supabase dropped a session the server refused: keep the
						// person and their waiting changes, and ask them to sign in
						// again.
						if (deliberate || !user) {
							setUser(null);
						}
						else {
							setExpired(true);
						}
					}
				}, 0);
			});

			return client;
		}).catch((err) => {
			clientPromise = null;

			throw err;
		});
	}

	return clientPromise;
}

function storedSession() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);

		return raw ? JSON.parse(raw) : null;
	}
	catch {
		return null;
	}
}

function setUser(next) {
	const changed = (next && next.id) !== (user && user.id);

	user = next || null;

	if (!user) {
		setExpired(false);
	}

	if (changed) {
		listeners.forEach((listener) => listener(user));
	}
}

export const currentUser = () => user;

// ------------------------------------------------------- an ended session

// True while the server no longer accepts this phone's session for the
// person still shown as signed in: nothing reaches the server until they
// sign in again.
export const sessionExpired = () => expired;

// listener({expired}) runs when the session ends and when a new sign-in
// brings it back (for the same person too, which onUser does not report).
// Returns the unsubscribe function.
export function onSession(listener) {
	sessionListeners.add(listener);

	return () => sessionListeners.delete(listener);
}

function readEnded() {
	try {
		const saved = JSON.parse(localStorage.getItem(ENDED_KEY) || 'null');

		return saved && saved.user && saved.user.id ? saved : null;
	}
	catch {
		return null;
	}
}

function setExpired(value) {
	if (value && !user) {
		return;
	}

	try {
		if (value) {
			localStorage.setItem(ENDED_KEY, JSON.stringify({at: Date.now(), user: {email: user.email, id: user.id}}));
		}
		else {
			localStorage.removeItem(ENDED_KEY);
		}
	}
	catch {
		// This visit still knows.
	}

	if (expired !== value) {
		expired = value;
		sessionListeners.forEach((listener) => listener({expired}));
	}
}

function signedOutLately() {
	try {
		return Date.now() - Number(localStorage.getItem(SIGNED_OUT_KEY) || 0) < SIGNED_OUT_FOR_MS;
	}
	catch {
		return false;
	}
}

// Whether an error from Supabase Auth means the session is over (the
// refresh token refused, no session left), rather than no signal.
export function isSessionRefusal(err) {
	if (!err) {
		return false;
	}

	const name = String(err.name || '');
	const text = `${err.code || ''} ${err.error_code || ''} ${err.message || ''}`;

	if (/RetryableFetchError/.test(name)) {
		return false;
	}

	if (/AuthSessionMissingError|AuthInvalidTokenResponseError/.test(name)) {
		return true;
	}

	if (/refresh_token_not_found|refresh_token_already_used|session_not_found|session_expired|bad_jwt|invalid refresh token|refresh token not found|jwt expired|invalid jwt/i.test(text)) {
		return true;
	}

	const status = Number(err.status);

	return name === 'AuthApiError' && status >= 400 && status < 500 && status !== 429;
}

// Whether a refused request (an HTTP status, and its error's words) could
// be the session: a 401, or a refusal that names the token. js/photos uses
// it to wait for a sign-in rather than give up on an upload.
export function isAuthStatus(status, message = '') {
	const code = Number(status);

	return code === 401 || ((code === 400 || code === 403) && /jwt|token|session|unauthorized/i.test(String(message)) && !/row-level security/i.test(String(message)));
}

// The server ended the session: keep the person on this phone, drop the dead
// session (so a reload or a sign-in link starts clean), and ask them to sign
// in again.
async function endSession() {
	if (!user || expired) {
		return;
	}

	setExpired(true);

	try {
		const client = await getClient();

		await client.auth.signOut({scope: 'local'});
	}
	catch {
		// The session is unusable either way.
	}
}

// A request was refused with a token that may no longer pass. Refresh the
// session once: a fresh token means it was only stale, and a refused
// refresh means the session is over.
function verifySession() {
	if (verifying || expired || !user || Date.now() - verifiedAt < VERIFY_GAP_MS) {
		return verifying;
	}

	verifying = (async () => {
		// Never inside the client's own request.
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});

		const client = await getClient();
		const {data, error} = await client.auth.refreshSession();

		if (error) {
			if (isSessionRefusal(error)) {
				await endSession();
			}
		}
		else if (data && data.session) {
			setExpired(false);
			sessionListeners.forEach((listener) => listener({expired: false, renewed: true}));
		}
	})().catch(() => {}).finally(() => {
		verifying = null;
		verifiedAt = Date.now();
	});

	return verifying;
}

function bearerOf(input, init) {
	try {
		const fromInit = init && init.headers ? new Headers(init.headers).get('authorization') : null;
		const fromRequest = input && typeof input === 'object' && input.headers ? input.headers.get('authorization') : null;

		return String(fromInit || fromRequest || '');
	}
	catch {
		return '';
	}
}

// Every request the Supabase client makes passes here, so a refusal that
// may mean the session is over is noticed wherever it happens: the sync, a
// family read, a photo upload. Only data and storage requests made with a
// person's token count; a refusal of the publishable key alone is just
// being signed out.
async function watchedFetch(input, init) {
	const response = await fetch(input, init);

	if (response.ok || response.status >= 500) {
		return response;
	}

	const address = String(input && typeof input === 'object' && 'url' in input ? input.url : input);

	if (!/\/(rest|storage)\/v1\//.test(address) || !/^Bearer [^.\s]+\.[^.\s]+\.[^.\s]+$/.test(bearerOf(input, init))) {
		return response;
	}

	if (response.status === 401) {
		verifySession();
	}
	else if (response.status === 400 || response.status === 403) {
		response.clone().text().then((text) => {
			if (isAuthStatus(response.status, text)) {
				verifySession();
			}
		}).catch(() => {});
	}

	return response;
}

// listener(user or null) runs when someone signs in or out. Returns the
// unsubscribe function.
export function onUser(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

// Reads the session saved on this phone, if any. A saved session counts as
// signed in even with no signal: the token is refreshed when the phone is
// back online.
//
// A session the server ended on an earlier visit comes back as the same
// person with sessionExpired() true, unless a sign-in link is coming back
// right now, which then signs them in.
export async function restoreSession() {
	const saved = storedSession();

	if (!saved) {
		const ended = readEnded();

		if (ended && !returning) {
			setUser(ended.user);
			setExpired(true);
		}

		return user;
	}

	if (saved.user) {
		setUser(saved.user);
	}

	try {
		const client = await getClient();
		const {data} = await client.auth.getSession();

		if (data && data.session) {
			setUser(data.session.user);
		}
		else if (!storedSession()) {
			// Supabase dropped a session it could not refresh: the server
			// ended it, so ask for a new sign-in rather than signing out.
			setExpired(true);
		}
	}
	catch {
		// Offline before the client file was saved: keep the saved user.
	}

	return user;
}

// The ?code= (or the error) a sign-in link or Google brings back. Read and
// removed from the address bar before the first render, so the code never
// stays in history or a bookmark.
//
// An invitation sent from the Supabase dashboard is the one link that does
// not use PKCE: it comes back with the session in the # fragment. That is
// read the same way and the fragment removed at once, before any camera use.
export function takeAuthReturn() {
	const url = new URL(window.location.href);
	const query = url.searchParams;
	const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
	const code = query.get('code');
	const error = query.get('error_description') || query.get('error')
		|| hash.get('error_description') || hash.get('error');
	const errorCode = query.get('error_code') || hash.get('error_code');
	const tokens = hash.get('access_token') && hash.get('refresh_token')
		? {access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token')}
		: null;

	if (!code && !error && !tokens) {
		return null;
	}

	returning = Boolean(code || tokens);

	for (const key of ['code', 'error', 'error_code', 'error_description']) {
		query.delete(key);
	}

	const search = query.toString();

	history.replaceState(history.state, '', url.pathname + (search ? `?${search}` : ''));

	return {code, error: error ? {code: errorCode, message: error} : null, tokens};
}

// Signs in with the session an invitation link carried.
export async function completeInvite(tokens) {
	const client = await getClient();
	const {data, error} = await client.auth.setSession(tokens);

	if (error) {
		throw error;
	}

	setUser(data.user || (data.session && data.session.user));
	// A new session: what waited on the phone can go up (js/sync.js).
	setExpired(false);

	return user;
}

export async function completeSignIn(code) {
	const client = await getClient();
	const {data, error} = await client.auth.exchangeCodeForSession(code);

	if (error) {
		throw error;
	}

	setUser(data.user || (data.session && data.session.user));
	// A new session: what waited on the phone can go up (js/sync.js).
	setExpired(false);

	return user;
}

// Never creates an account: sign-up is closed in the dashboard, and
// shouldCreateUser: false keeps it closed even if that switch is turned
// back on. An address with no account gets "not been invited".
export async function sendSignInLink(email) {
	const client = await getClient();
	const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo: siteUrl(), shouldCreateUser: false}});

	if (error) {
		throw error;
	}
}

// The sign-in address for what was typed in the account-name field: a bare
// name gets the placeholder domain, and an address with "@" is used as typed,
// so an email and a password work too.
export function accountNameEmail(name) {
	const text = String(name || '').trim().toLowerCase();

	return !text || text.includes('@') ? text : `${text}@${ACCOUNT_NAME_DOMAIN}`;
}

// Whether an address is a placeholder for an account with no email.
export const isAccountNameEmail = (email) => String(email || '').toLowerCase().endsWith(`@${ACCOUNT_NAME_DOMAIN}`);

// An address as people should see it: an account name alone, never its
// placeholder domain, which reads like an email but is not one.
export const accountLabel = (email) => (isAccountNameEmail(email) ? String(email).split('@')[0] : email || '');

export async function signInWithName(name, password) {
	const client = await getClient();
	const {data, error} = await client.auth.signInWithPassword({email: accountNameEmail(name), password});

	if (error) {
		throw error;
	}

	setUser(data.user || (data.session && data.session.user));
	// A new session: what waited on the phone can go up (js/sync.js).
	setExpired(false);

	return user;
}

// For a signed-in account-name account; the length is checked before this.
export async function changePassword(password) {
	const client = await getClient();
	const {error} = await client.auth.updateUser({password});

	if (error) {
		throw error;
	}
}

export async function signInWithGoogle() {
	const client = await getClient();
	const {error} = await client.auth.signInWithOAuth({provider: 'google', options: {redirectTo: siteUrl()}});

	if (error) {
		throw error;
	}
}

// Signs this phone out only; other devices stay signed in. The cards stay on
// the phone.
export async function signOut() {
	const client = await getClient();

	signingOut = true;

	try {
		localStorage.setItem(SIGNED_OUT_KEY, String(Date.now()));
	}
	catch {
		// This tab still knows.
	}

	const {error} = await client.auth.signOut({scope: 'local'}).finally(() => {
		signingOut = false;
	});

	setUser(null);

	if (error) {
		throw error;
	}
}

// Whether the project offers Google sign-in, from Supabase's public auth
// settings. Kept ten minutes. Any failure reads as "no", so the button
// stays hidden rather than leading to an error.
export async function googleEnabled() {
	try {
		const saved = JSON.parse(sessionStorage.getItem(SETTINGS_KEY) || 'null');

		if (saved && Date.now() - saved.at < SETTINGS_FOR_MS) {
			return saved.google === true;
		}
	}
	catch {
		// Read it again.
	}

	try {
		const response = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {headers: {apikey: SUPABASE_KEY}});

		if (!response.ok) {
			return false;
		}

		const settings = await response.json();
		const google = Boolean(settings && settings.external && settings.external.google === true);

		try {
			sessionStorage.setItem(SETTINGS_KEY, JSON.stringify({at: Date.now(), google}));
		}
		catch {
			// Asked again next time.
		}

		return google;
	}
	catch {
		return false;
	}
}

// Words for the errors a person can meet while signing in.
export function signInErrorText(err) {
	const message = String((err && (err.message || err.msg)) || err || '');
	const code = String((err && err.code) || '');
	const status = err && err.status;

	if (!navigator.onLine) {
		return 'You are offline. Signing in needs a connection.';
	}

	// Supabase gives one answer for an unknown name and a wrong password, and
	// so does this.
	if (/invalid_credentials|invalid login credentials/i.test(code + message)) {
		return 'That name and password do not match. Ask the family owner if you forgot it.';
	}

	if (/over_request_rate_limit/i.test(code)) {
		return 'Too many tries in a short time. Wait a few minutes and try again.';
	}

	if (status === 429 || /rate limit|over_email_send_rate_limit/i.test(code + message)) {
		return 'Too many sign-in emails were sent. The email service sends only a few an hour, so wait a while and try again.';
	}

	if (/signup|sign up|not allowed/i.test(code + message)) {
		return 'That email has not been invited yet. Ask the family owner for an invite.';
	}

	if (/otp_expired|expired|invalid/i.test(code + message)) {
		return 'That sign-in link has expired or was already used. Ask for a new one.';
	}

	if (/code verifier|flow state|pkce/i.test(code + message)) {
		return 'Open the sign-in link in the same browser you asked for it from, or ask for a new link here.';
	}

	return message || 'Signing in did not work. Try again.';
}

// Words for the errors a person can meet while changing their password.
export function passwordErrorText(err) {
	const message = String((err && (err.message || err.msg)) || err || '');
	const code = String((err && err.code) || '');

	if (!navigator.onLine) {
		return 'You are offline. Changing the password needs a connection.';
	}

	if (/same_password|different from the old/i.test(code + message)) {
		return 'That is the password you have now. Choose a new one.';
	}

	// The server's own words say what a stronger password needs.
	if (/weak_password/i.test(code)) {
		return `That password is too easy to guess. ${message}`.trim();
	}

	if (/session|jwt|reauthentication/i.test(code + message)) {
		return 'Sign out, sign in again, and then change the password.';
	}

	return message || 'The password did not change. Try again.';
}
