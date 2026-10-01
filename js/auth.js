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

import {BASE} from './dom.js';

export const SUPABASE_URL = 'https://ehdkbxrjxsypegbtrxbw.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_Ycfz9bobfuvHWdDKjaoQQA_LDYmm0vJ';

const STORAGE_KEY = 'card-tracker-auth';
const SETTINGS_KEY = 'cardTracker.authSettings';
const SETTINGS_FOR_MS = 10 * 60 * 1000;

export const ACCOUNT_NAME_DOMAIN = 'family.invalid';
export const MIN_PASSWORD_LENGTH = 8;

let clientPromise = null;
let user = null;

const listeners = new Set();

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
			});

			client.auth.onAuthStateChange((event, session) => {
				// Supabase asks that this callback not await its own calls, so
				// listeners run on the next turn.
				setTimeout(() => setUser(session ? session.user : event === 'SIGNED_OUT' ? null : user), 0);
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

	if (changed) {
		listeners.forEach((listener) => listener(user));
	}
}

export const currentUser = () => user;

// listener(user or null) runs when someone signs in or out. Returns the
// unsubscribe function.
export function onUser(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

// Reads the session saved on this phone, if any. A saved session counts as
// signed in even with no signal: the token is refreshed when the phone is
// back online.
export async function restoreSession() {
	const saved = storedSession();

	if (!saved) {
		return null;
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
			// Supabase dropped a session it could not refresh.
			setUser(null);
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

	return user;
}

export async function completeSignIn(code) {
	const client = await getClient();
	const {data, error} = await client.auth.exchangeCodeForSession(code);

	if (error) {
		throw error;
	}

	setUser(data.user || (data.session && data.session.user));

	return user;
}

export async function sendSignInLink(email) {
	const client = await getClient();
	const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo: siteUrl()}});

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
	const {error} = await client.auth.signOut({scope: 'local'});

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
