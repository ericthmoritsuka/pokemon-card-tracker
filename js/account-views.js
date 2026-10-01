// Sign in and Profile (plans/ux-plan.md section 2). Sign in is the only entry
// screen for an invited person: there is no other way to make an account.
// Signing in is optional; signed out, the app keeps the cards on this phone.

import {currentUser, googleEnabled, onUser, sendSignInLink, signInErrorText, signInWithGoogle, signOut} from './auth.js';
import {BASE, errorText, go, h} from './dom.js';
import {
	displayName,
	familyCall,
	familyOverview,
	onSyncStatus,
	pendingChanges,
	setupError,
	statusText,
	syncNow,
	updateDisplayName,
} from './sync.js';

const RESEND_AFTER_MS = 60 * 1000;

// A message for the Sign in screen from a sign-in link that did not work.
let notice = null;

export function setSignInNotice(message) {
	notice = message;
}

export const memberName = (member) =>
	(member && (member.display_name || (member.email ? member.email.split('@')[0] : null))) || 'Family member';

// ---------------------------------------------------------------- Sign in

export function signInView(root) {
	let alive = true;
	let lastSent = 0;
	let sentTo = '';

	const message = h('div', {'aria-live': 'polite'});
	const body = h('div');

	if (notice) {
		message.append(h('div', {class: 'notice', role: 'alert'}, h('p', null, notice)));
		notice = null;
	}

	function signedIn(user) {
		body.replaceChildren(
			h('div', {class: 'card'},
				h('p', null, `You are signed in as ${user.email}.`),
				h('a', {class: 'button primary', 'data-link': 'profile', href: `${BASE}profile`}, 'Open Profile')
			)
		);
	}

	function form() {
		const email = h('input', {
			autocomplete: 'email',
			class: 'search',
			id: 'signin-email',
			inputmode: 'email',
			name: 'email',
			required: true,
			type: 'email',
			value: sentTo,
		});
		const send = h('button', {class: 'primary', type: 'submit'}, 'Send link');
		const google = h('button', {hidden: true, id: 'signin-google', onclick: withGoogle, type: 'button'}, 'Continue with Google');
		const or = h('p', {class: 'muted or', hidden: true}, 'or');
		const error = h('p', {class: 'form-error', role: 'alert'});

		async function submit(event) {
			event.preventDefault();
			error.textContent = '';

			const address = email.value.trim();

			if (!address) {
				return;
			}

			send.disabled = true;
			send.textContent = 'Sending...';

			try {
				await sendSignInLink(address);
				sentTo = address;
				lastSent = Date.now();

				if (alive) {
					checkEmail();
				}
			}
			catch (err) {
				if (alive) {
					error.textContent = signInErrorText(err);
					send.disabled = false;
					send.textContent = 'Send link';
				}
			}
		}

		async function withGoogle() {
			error.textContent = '';
			google.disabled = true;

			try {
				// Leaves the page for Google, then comes back with ?code=.
				await signInWithGoogle();
			}
			catch (err) {
				if (alive) {
					error.textContent = signInErrorText(err);
					google.disabled = false;
				}
			}
		}

		body.replaceChildren(
			h('form', {class: 'card signin', novalidate: false, onsubmit: submit},
				h('label', {for: 'signin-email'}, 'Email'),
				email,
				send,
				error,
				or,
				google
			),
			h('p', {class: 'muted'}, 'Signing in keeps your cards on the server too, so they follow you to another phone and your family can see them. Without signing in, Card Tracker keeps your cards on this phone only.')
		);

		googleEnabled().then((enabled) => {
			if (alive && enabled) {
				google.hidden = false;
				or.hidden = false;
			}
		});
	}

	function checkEmail() {
		const resend = h('button', {disabled: true, type: 'button'}, 'Send again');
		const error = h('p', {class: 'form-error', role: 'alert'});
		const wait = () => Math.max(0, RESEND_AFTER_MS - (Date.now() - lastSent));

		const tick = () => {
			if (!alive || !resend.isConnected) {
				return;
			}

			const left = wait();

			resend.disabled = left > 0;
			resend.textContent = left > 0 ? `Send again in ${Math.ceil(left / 1000)} s` : 'Send again';

			if (left > 0) {
				setTimeout(tick, 1000);
			}
		};

		resend.addEventListener('click', async () => {
			resend.disabled = true;
			error.textContent = '';

			try {
				await sendSignInLink(sentTo);
				lastSent = Date.now();
			}
			catch (err) {
				error.textContent = signInErrorText(err);
			}

			tick();
		});

		body.replaceChildren(
			h('div', {class: 'card', id: 'check-email'},
				h('p', {class: 'big'}, 'Check your email'),
				h('p', null, `A sign-in link is on its way to ${sentTo}. Open it on this phone, in this browser.`),
				h('p', {class: 'muted'}, 'The link works once and expires after an hour. If nothing arrives in a few minutes, look in spam.'),
				error,
				resend,
				h('button', {class: 'link-button', onclick: form, type: 'button'}, 'Use a different email')
			)
		);
		tick();
	}

	function draw(user) {
		if (!alive) {
			return;
		}

		if (user) {
			signedIn(user);
		}
		else if (!body.childElementCount) {
			form();
		}
	}

	const stop = onUser(draw);

	root.append(h('h2', null, 'Sign in'), message, body);
	draw(currentUser());

	return () => {
		alive = false;
		stop();
	};
}

// ---------------------------------------------------------------- Profile

export function profileView(root) {
	let alive = true;

	const user = currentUser();

	if (!user) {
		root.append(
			h('h2', null, 'Profile'),
			h('div', {class: 'card'},
				h('p', null, 'You are not signed in. Your cards are kept on this phone only.'),
				h('a', {class: 'button primary', 'data-link': 'signin', href: `${BASE}signin`}, 'Sign in')
			)
		);

		return null;
	}

	const nameInput = h('input', {autocomplete: 'nickname', class: 'search', id: 'profile-name', maxlength: 60, name: 'name', type: 'text'});
	const nameSave = h('button', {type: 'submit'}, 'Save name');
	const nameStatus = h('p', {'aria-live': 'polite', class: 'muted'});
	const syncLine = h('p', {class: 'muted', id: 'profile-sync'});
	const family = h('div', {'aria-live': 'polite', id: 'family'}, h('p', {class: 'muted'}, 'Loading your family group...'));
	const signOutStatus = h('p', {class: 'form-error', role: 'alert'});

	async function saveName(event) {
		event.preventDefault();
		nameSave.disabled = true;
		nameStatus.textContent = 'Saving...';

		try {
			await updateDisplayName(nameInput.value.trim());
			nameStatus.textContent = 'Saved. Your family sees this name.';
			loadFamily(true);
		}
		catch (err) {
			nameStatus.textContent = navigator.onLine ? `Could not save the name. ${errorText(err)}` : 'Saving the name needs a connection.';
		}

		nameSave.disabled = false;
	}

	async function doSignOut() {
		const waiting = await pendingChanges();

		if (waiting && !window.confirm(`${waiting.toLocaleString('en-US')} ${waiting === 1 ? 'change has' : 'changes have'} not reached the server yet. They stay on this phone and are saved the next time you sign in here. Sign out?`)) {
			return;
		}

		try {
			await signOut();
			go('cards');
		}
		catch (err) {
			signOutStatus.textContent = `Signed out on this phone, but the server was not told. ${errorText(err)}`;
		}
	}

	function memberRow(member, overview, me) {
		const isOwner = overview.role === 'owner';
		const row = h('li', {class: 'member'},
			h('span', {class: 'member-text'},
				h('span', {class: 'member-name'}, memberName(member), member.user_id === me ? ' (you)' : ''),
				h('span', {class: 'muted'}, [member.role === 'owner' ? 'Owner' : 'Member', member.email].filter(Boolean).join(' · '))
			)
		);

		if (isOwner && member.role !== 'owner') {
			const remove = h('button', {class: 'small danger', type: 'button'}, 'Remove');

			remove.addEventListener('click', async () => {
				if (!window.confirm(`Remove ${memberName(member)} from the family group? They keep their account and their cards, and stop seeing yours.`)) {
					return;
				}

				remove.disabled = true;

				try {
					await familyCall('remove_member', {user_id: member.user_id});
					loadFamily(true);
				}
				catch (err) {
					remove.disabled = false;
					row.append(h('p', {class: 'form-error', role: 'alert'}, (err && err.message) || errorText(err)));
				}
			});
			row.append(remove);
		}

		return row;
	}

	function addMemberForm() {
		const email = h('input', {autocomplete: 'off', class: 'search', id: 'add-member-email', inputmode: 'email', name: 'email', required: true, type: 'email'});
		const add = h('button', {class: 'primary', type: 'submit'}, 'Add member');
		const status = h('p', {'aria-live': 'polite', class: 'muted'});

		async function submit(event) {
			event.preventDefault();

			const address = email.value.trim();

			if (!address) {
				return;
			}

			add.disabled = true;
			status.textContent = 'Adding...';

			try {
				await familyCall('add_member', {email: address});
				email.value = '';
				status.textContent = `Added ${address}.`;
				loadFamily(true, status.textContent);
			}
			catch (err) {
				status.textContent = (err && err.message) || errorText(err);
			}

			add.disabled = false;
		}

		return h('form', {class: 'add-member', id: 'add-member', onsubmit: submit},
			h('h4', null, 'Add member'),
			h('p', {class: 'muted'}, 'Invite them first in the Supabase dashboard (Authentication, Users, Invite). Once the invite is sent, add their email here.'),
			h('label', {for: 'add-member-email'}, 'Email'),
			email,
			add,
			status
		);
	}

	async function loadFamily(fresh = false, keepMessage = null) {
		let overview;

		try {
			overview = await familyOverview({fresh});
		}
		catch (err) {
			if (alive) {
				family.replaceChildren(h('p', {class: 'muted'}, navigator.onLine
					? `The family group could not be read. ${errorText(setupError() || err)}`
					: 'The family group shows when you are online.'));
			}

			return;
		}

		if (!alive) {
			return;
		}

		if (!overview || !overview.group) {
			family.replaceChildren(h('p', {class: 'muted'}, 'You are not in a family group yet. The family owner can add you.'));

			return;
		}

		const list = h('ul', {class: 'members'}, overview.members.map((member) => memberRow(member, overview, user.id)));

		family.replaceChildren(
			h('p', null, overview.group.name),
			list,
			overview.role === 'owner' ? addMemberForm() : null
		);

		if (keepMessage) {
			const form = family.querySelector('#add-member p[aria-live]');

			if (form) {
				form.textContent = keepMessage;
			}
		}
	}

	const stopStatus = onSyncStatus((status) => {
		const text = statusText(status);
		const error = status.phase === 'error' && status.error ? ` ${errorText(status.error)}` : '';

		syncLine.textContent = text ? `Sync: ${text}.${error}` : '';
	});

	root.append(
		h('h2', null, 'Profile'),
		h('div', {class: 'card'},
			h('h3', null, 'Account'),
			h('p', {id: 'profile-email'}, user.email),
			syncLine,
			h('button', {onclick: () => syncNow(), type: 'button'}, 'Sync now')
		),
		h('form', {class: 'card', onsubmit: saveName},
			h('h3', null, 'Display name'),
			h('label', {class: 'muted', for: 'profile-name'}, 'The name your family sees'),
			nameInput,
			nameSave,
			nameStatus
		),
		h('div', {class: 'card'},
			h('h3', null, 'Family'),
			family
		),
		h('div', {class: 'card'},
			h('p', {class: 'muted'}, 'Signing out keeps your cards on this phone.'),
			h('button', {class: 'danger', id: 'sign-out', onclick: doSignOut, type: 'button'}, 'Sign out'),
			signOutStatus
		)
	);

	displayName().then((name) => {
		if (alive && name && !nameInput.value) {
			nameInput.value = name;
		}
	}).catch(() => {});

	loadFamily();

	return () => {
		alive = false;
		stopStatus();
	};
}
