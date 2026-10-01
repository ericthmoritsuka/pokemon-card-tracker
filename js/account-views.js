// Sign in and Profile (plans/ux-plan.md section 2, plans/design-review.md
// section 3, "Profile and Themes"). The header avatar opens Profile, which
// holds the theme, the favorite Pokémon, import and export, Phone check, the
// family, and signing in or out. Signed out, Profile opens on the sign-in
// panel. Sign in is the only entry for an invited person: there is no other
// way to make an account. Signing in is optional; signed out, the app keeps
// the cards on this phone.

import {currentUser, googleEnabled, onUser, sendSignInLink, signInErrorText, signInWithGoogle, signOut} from './auth.js';
import {canShareFiles, exportCollection} from './cards-view.js';
import {dexLabel, MAX_DEX, nameOf, pokemonNames, spriteUrl} from './checklists.js';
import {BASE, errorText, go, h} from './dom.js';
import {memberName} from './family.js';
import {chooseTheme, currentTheme, favoritePokemon, onSettings, primaryType, setFavoritePokemon} from './settings.js';
import {THEMES, themeById} from './themes.js';
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

// js/family.js holds it; the views that import it from here still can.
export {memberName};

// ---------------------------------------------------------------- Sign in

// The email link form and, when the project turns it on, Google. Returns
// {element, stop}; Profile shows it at the top when signed out (onIntent:
// Google is looked up when the email field is first focused), and the
// signin route shows it alone.
function signInPanel({onIntent = false} = {}) {
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

		const showGoogle = () => googleEnabled().then((enabled) => {
			if (alive && enabled) {
				google.hidden = false;
				or.hidden = false;
			}
		});

		// In Profile, the project is asked about Google only once the person
		// starts to sign in, so browsing Profile signed out never contacts
		// Supabase. The button appears below the field being filled in.
		if (onIntent) {
			email.addEventListener('focus', showGoogle, {once: true});
		}
		else {
			showGoogle();
		}
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

	draw(currentUser());

	return {
		element: h('div', {class: 'signin-panel', id: 'signin-panel'}, message, body),
		stop: () => {
			alive = false;
			stop();
		},
	};
}

export function signInView(root) {
	const panel = signInPanel();

	root.append(h('h2', null, 'Sign in'), panel.element);

	return panel.stop;
}

// ---------------------------------------------------------------- Profile

export function profileView(root) {
	let alive = true;

	const user = currentUser();

	if (!user) {
		// Signed out, the sign-in panel comes first, then everything that
		// works on this phone alone.
		const panel = signInPanel({onIntent: true});
		const theme = themeCard(false);

		root.append(
			h('h2', null, 'Profile'),
			h('section', {'aria-labelledby': 'signin-heading', class: 'card', id: 'profile-signin'},
				h('h3', {id: 'signin-heading'}, 'Sign in'),
				h('p', {class: 'muted'}, 'You are not signed in. Your cards are kept on this phone only.'),
				panel.element
			),
			theme.element,
			dataCard(),
			phoneCard()
		);

		return () => {
			panel.stop();
			theme.stop();
		};
	}

	const favorite = favoriteCard();
	const theme = themeCard(true);

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

		// Profile > Family is one way into view-only mode (js/shell.js).
		if (member.user_id !== me) {
			row.append(h('a', {
				class: 'button small member-view',
				'data-link': `family/${encodeURIComponent(member.user_id)}`,
				href: `${BASE}family/${encodeURIComponent(member.user_id)}`,
			}, 'View cards'));
		}

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

	const accountSprite = h('span', {class: 'profile-sprite', id: 'profile-sprite'});

	function drawAccountSprite() {
		favoritePokemon().then((n) => {
			if (alive) {
				accountSprite.replaceChildren(...(n ? [sprite(n, 72)] : []));
			}
		}).catch(() => {});
	}

	const stopSprite = onSettings(drawAccountSprite);

	drawAccountSprite();

	root.append(
		h('h2', null, 'Profile'),
		h('div', {class: 'card profile-account'},
			accountSprite,
			h('div', {class: 'profile-account-text'},
				h('h3', null, 'Account'),
				h('p', {id: 'profile-email'}, user.email),
				syncLine,
				h('button', {onclick: () => syncNow(), type: 'button'}, 'Sync now')
			)
		),
		h('form', {class: 'card', onsubmit: saveName},
			h('h3', null, 'Display name'),
			h('label', {class: 'muted', for: 'profile-name'}, 'The name your family sees'),
			nameInput,
			nameSave,
			nameStatus
		),
		favorite.element,
		theme.element,
		h('div', {class: 'card', id: 'family-card'},
			h('h3', null, 'Family'),
			family
		),
		dataCard(),
		phoneCard(),
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
		stopSprite();
		favorite.stop();
		theme.stop();
	};
}

// ------------------------------------------------- Your data, This phone

// Import from monprice and the CSV export, moved here from My Cards so
// backup tools do not outrank the collection.
function dataCard() {
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'export-status'});
	const run = async (share) => {
		status.textContent = 'Preparing the export...';

		try {
			const count = await exportCollection({share});

			status.textContent = count ? `Exported ${count.toLocaleString('en-US')} ${count === 1 ? 'copy' : 'copies'}.` : '';
		}
		catch (err) {
			status.textContent = `The export did not work. ${errorText(err)}`;
		}
	};

	return h('section', {'aria-labelledby': 'data-heading', class: 'card', id: 'data-card'},
		h('h3', {id: 'data-heading'}, 'Your data'),
		h('div', {class: 'stack-links'},
			h('a', {class: 'button', 'data-link': 'import', href: `${BASE}import`, id: 'profile-import'}, 'Import from monprice'),
			h('button', {id: 'profile-export', onclick: () => run(false), type: 'button'}, 'Export CSV'),
			canShareFiles() ? h('button', {id: 'profile-share', onclick: () => run(true), type: 'button'}, 'Share CSV') : null
		),
		status
	);
}

function phoneCard() {
	return h('section', {'aria-labelledby': 'phone-heading', class: 'card', id: 'phone-card'},
		h('h3', {id: 'phone-heading'}, 'This phone'),
		h('p', {class: 'muted'}, 'Checks the camera and storage this app needs.'),
		h('a', {class: 'button', 'data-link': 'check', href: `${BASE}check`, id: 'profile-phone-check'}, 'Phone check')
	);
}


// ---------------------------------------------------------------- Theme

// A swatch per theme, named by type. Choosing one applies it at once, which
// is the live preview for the whole app; the preview panel shows the theme
// under the finger or the focus before it is chosen. Signed in, the choice
// is saved to the document and syncs; signed out, it stays on this phone.
function themeCard(signedIn) {
	const preview = h('div', {'aria-hidden': 'true', class: 'theme-preview', id: 'theme-preview'});
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'theme-status'});
	const grid = h('fieldset', {class: 'theme-grid', id: 'theme-grid'}, h('legend', {class: 'offscreen'}, 'Theme'));

	function drawPreview(id) {
		const theme = themeById(id) || THEMES[0];

		preview.dataset.theme = theme.id;
		preview.replaceChildren(
			h('div', {class: 'preview-bar'}, h('span', null, `${theme.name} theme`), h('span', {class: 'preview-avatar'}, 'A')),
			h('div', {class: 'preview-body'},
				h('div', {class: 'card'},
					h('p', {class: 'big'}, 'A panel'),
					h('p', {class: 'muted'}, 'Muted text on the panel tint.'),
					h('p', null, h('span', {class: 'preview-link'}, 'A link')),
					h('div', {class: 'preview-buttons'},
						h('span', {class: 'button primary'}, 'Save'),
						h('span', {class: 'button danger-like'}, 'Delete')
					)
				)
			)
		);
	}

	for (const theme of THEMES) {
		const input = h('input', {checked: theme.id === currentTheme(), name: 'theme', type: 'radio', value: theme.id});
		const option = h('label', {class: 'theme-option', 'data-theme-id': theme.id},
			input,
			h('span', {class: 'swatch'},
				h('span', {'aria-hidden': 'true', class: 'swatch-chip', style: `--sw-light: ${theme.light}; --sw-dark: ${theme.dark}`}),
				h('span', {class: 'swatch-name'}, theme.name)
			)
		);

		input.addEventListener('change', async () => {
			if (!input.checked) {
				return;
			}

			drawPreview(theme.id);

			try {
				const saved = await chooseTheme(theme.id);

				status.textContent = signedIn
					? `${themeById(saved).name} theme saved. It follows you to every device.`
					: `${themeById(saved).name} theme saved on this phone. Sign in to keep it on every device.`;
			}
			catch (err) {
				status.textContent = `The theme is on, but it could not be saved. ${errorText(err)}`;
			}
		});

		// A look before choosing: hovering or focusing shows it in the preview.
		const show = () => drawPreview(theme.id);
		const back = () => drawPreview(currentTheme());

		option.addEventListener('pointerenter', show);
		option.addEventListener('pointerleave', back);
		input.addEventListener('focus', show);
		input.addEventListener('blur', back);

		grid.append(option);
	}

	// Another device's theme arrives with a sync: keep the grid in step.
	const stop = onSettings(() => {
		const id = currentTheme();

		for (const input of grid.querySelectorAll('input')) {
			input.checked = input.value === id;
		}

		if (!grid.contains(document.activeElement)) {
			drawPreview(id);
		}
	});

	drawPreview(currentTheme());

	return {
		element: h('section', {'aria-labelledby': 'theme-heading', class: 'card', id: 'theme-card'},
			h('h3', {id: 'theme-heading'}, 'Theme'),
			h('p', {class: 'muted'}, signedIn
				? 'One theme per Pokémon type. It follows you to every device.'
				: 'One theme per Pokémon type. Signed out, it is kept on this phone.'),
			preview,
			grid,
			status
		),
		stop,
	};
}

// ------------------------------------------------------- Favorite Pokémon

// A sprite, or the dex number in a circle when the image fails or is not on
// the phone.
function sprite(n, size = 56) {
	const wrap = h('span', {'aria-hidden': 'true', class: 'sprite-wrap'});
	const img = h('img', {alt: '', class: 'sprite', decoding: 'async', height: size, loading: 'lazy', width: size});

	img.addEventListener('error', () => wrap.replaceChildren(h('span', {class: 'sprite-fallback'}, String(n))), {once: true});
	img.src = spriteUrl(n);
	wrap.append(img);

	return wrap;
}

const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Search by name or National Dex number; one tap picks. The favorite shows
// in the header and the browser tab, and suggests its type's theme, which
// the person applies with one more tap or ignores.
function favoriteCard() {
	let alive = true;
	let names = Array(MAX_DEX + 1).fill(null);
	let chosen = null;
	let suggestFor = 0;

	const current = h('div', {class: 'favorite-current', id: 'favorite-current'});
	const suggestion = h('div', {'aria-live': 'polite', id: 'theme-suggestion'});
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'favorite-status'});
	const search = h('input', {
		autocomplete: 'off',
		class: 'search',
		id: 'favorite-search',
		placeholder: 'Name or number, e.g. Eevee or 133',
		type: 'search',
	});
	const results = h('ul', {class: 'picker-results', id: 'favorite-results'});

	function drawCurrent() {
		if (!chosen) {
			current.replaceChildren(h('p', {class: 'muted'}, 'No favorite yet. It shows in the header and on the browser tab while you are signed in.'));

			return;
		}

		const clear = h('button', {class: 'link-button', id: 'favorite-clear', type: 'button'}, 'Remove favorite');

		clear.addEventListener('click', () => pick(null));
		current.replaceChildren(
			sprite(chosen, 72),
			h('span', {class: 'dex-text'},
				h('span', {class: 'dex-num'}, dexLabel(chosen)),
				h('span', {class: 'dex-name', id: 'favorite-name'}, nameOf(names, chosen)),
				clear
			)
		);
	}

	// The type theme for the favorite, offered while another theme is on.
	async function drawSuggestion() {
		const n = chosen;

		suggestFor = n;

		if (!n) {
			suggestion.replaceChildren();

			return;
		}

		const type = await primaryType(n);

		if (!alive || suggestFor !== n) {
			return;
		}

		const theme = type ? themeById(type) : null;

		if (!theme || currentTheme() === theme.id) {
			suggestion.replaceChildren();

			return;
		}

		const use = h('button', {class: 'primary', id: 'suggestion-apply', type: 'button'}, `Use the ${theme.name} theme`);

		use.addEventListener('click', async () => {
			use.disabled = true;

			try {
				await chooseTheme(theme.id);
			}
			catch (err) {
				status.textContent = `The theme is on, but it could not be saved. ${errorText(err)}`;
			}
		});

		suggestion.replaceChildren(h('div', {class: 'notice suggestion'},
			h('p', null, `${nameOf(names, n)} is ${/^[aeiou]/i.test(theme.name) ? 'an' : 'a'} ${theme.name} type. Want the ${theme.name} theme to match?`),
			use
		));
	}

	async function pick(n) {
		status.textContent = 'Saving...';

		try {
			if (!await setFavoritePokemon(n)) {
				status.textContent = 'Your account is still loading on this phone. Try again in a moment.';

				return;
			}

			chosen = n;
			status.textContent = n ? `${nameOf(names, n)} is your favorite.` : 'Favorite removed.';
			search.value = '';
			drawResults();
			drawCurrent();
			drawSuggestion();
		}
		catch (err) {
			status.textContent = `Could not save the favorite. ${errorText(err)}`;
		}
	}

	function matches(query) {
		const text = fold(query.trim()).replace(/^#/, '');

		if (!text) {
			return [];
		}

		if (/^\d+$/.test(text)) {
			const n = Number(text);

			return n >= 1 && n <= MAX_DEX ? [n] : [];
		}

		const starts = [];
		const contains = [];

		for (let n = 1; n <= MAX_DEX; n++) {
			const name = names[n] ? fold(names[n]) : '';

			if (name.startsWith(text)) {
				starts.push(n);
			}
			else if (name.includes(text)) {
				contains.push(n);
			}
		}

		return [...starts, ...contains].slice(0, 24);
	}

	function drawResults() {
		const found = matches(search.value);
		const known = names.some(Boolean);

		if (!found.length) {
			results.replaceChildren(...(search.value.trim()
				? [h('li', {class: 'muted'}, known ? 'No Pokémon by that name or number.' : 'Names are not on this phone yet; search by number.')]
				: []));

			return;
		}

		results.replaceChildren(...found.map((n) => h('li', null, h('button', {
			'aria-pressed': n === chosen ? 'true' : 'false',
			class: n === chosen ? 'picker-item picked' : 'picker-item',
			onclick: () => pick(n),
			type: 'button',
		},
		sprite(n, 40),
		h('span', {class: 'dex-num'}, dexLabel(n)),
		h('span', {class: 'dex-name'}, nameOf(names, n)),
		h('span', {class: 'picker-state'}, n === chosen ? 'Favorite' : 'Pick')))));
	}

	search.addEventListener('input', drawResults);

	// The suggestion goes once its theme is on, from here or from the picker.
	const stop = onSettings(async () => {
		const n = await favoritePokemon().catch(() => null);

		if (!alive) {
			return;
		}

		if (n !== chosen) {
			chosen = n;
			drawCurrent();
		}

		drawSuggestion();
	});

	favoritePokemon().then((n) => {
		if (alive) {
			chosen = n;
			drawCurrent();
			drawSuggestion();
		}
	}).catch(() => {});

	pokemonNames().then((list) => {
		if (alive) {
			names = list;
			drawCurrent();
			drawResults();
		}
	}).catch(() => {});

	drawCurrent();

	return {
		element: h('section', {'aria-labelledby': 'favorite-heading', class: 'card', id: 'favorite-card'},
			h('h3', {id: 'favorite-heading'}, 'Favorite Pokémon'),
			current,
			suggestion,
			h('label', {class: 'muted', for: 'favorite-search'}, 'Find a Pokémon by name or National Dex number'),
			search,
			results,
			status
		),
		stop: () => {
			alive = false;
			stop();
		},
	};
}
