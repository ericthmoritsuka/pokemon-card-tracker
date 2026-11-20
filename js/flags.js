// Country flags for the languages a card is printed in, in place of text
// chips such as "PT" and "KO".
//
// Small bundled SVGs from flag-icons 7.5.0 (MIT, vendor/flags/LICENSE),
// never emoji, which Windows shows as letters. A flag group always carries
// the language names as its aria-label and title, so its meaning never
// depends on the picture alone. flagPlan is pure, so Node can test it.

import {LANGUAGES, compareLanguages, languageChip, languageFlag, languageLabel} from './languages.js';

// The app root, as js/dom.js finds it; read here so Node can load this file
// without a window.
const BASE = new URL('../', import.meta.url).pathname;

// Language -> the flag-icons file it is shown with (js/languages.js).
export const FLAGS = Object.fromEntries(LANGUAGES.map((row) => [row.code, row.flag]));

export const MAX_FLAGS = 3;

export const flagLanguageName = languageLabel;

// The old text chip, for a language with no flag.
export const flagText = languageChip;

export const flagSrc = (code) => (languageFlag(code) ? `${BASE}vendor/flags/${languageFlag(code)}.svg` : null);

// What a group of languages shows: {items: [{code, src, text}], more, label}.
// At most MAX_FLAGS items, in the table's order, then "+N" for the rest; label
// names every language, the hidden ones too.
export function flagPlan(codes) {
	const unique = [...new Set((codes || []).filter(Boolean))].sort(compareLanguages);
	const shown = unique.slice(0, MAX_FLAGS);

	return {
		items: shown.map((code) => ({code, src: flagSrc(code), text: flagText(code)})),
		label: unique.map(flagLanguageName).join(', '),
		more: unique.length - shown.length,
	};
}

// The flag group as an element. className adds to "flags"; prefix goes
// before the names in the aria-label ("Printed in Korean"). Every tile of a
// grid draws one, mostly the same few, so each group is made once and
// copied after that (about 1.2 s over 1,200 tiles on a slow phone): a copy
// has the same attributes, and none carries a listener.
const madeBadges = new Map();

export function flagBadge(codes, {className = '', prefix = 'Printed in'} = {}) {
	const key = JSON.stringify([codes || [], className, prefix]);
	let made = madeBadges.get(key);

	if (!made) {
		made = drawFlagBadge(codes, {className, prefix});

		if (madeBadges.size >= 200) {
			madeBadges.clear();
		}

		madeBadges.set(key, made);
	}

	return made.cloneNode(true);
}

function drawFlagBadge(codes, {className, prefix}) {
	const plan = flagPlan(codes);
	const group = document.createElement('span');

	group.className = ['flags', className].filter(Boolean).join(' ');
	group.setAttribute('role', 'img');
	group.setAttribute('aria-label', prefix ? `${prefix} ${plan.label}` : plan.label);
	group.title = plan.label;

	for (const item of plan.items) {
		if (item.src) {
			const img = document.createElement('img');

			img.className = 'flag';
			img.alt = '';
			img.src = item.src;
			img.width = 21;
			img.height = 16;
			img.decoding = 'async';
			img.dataset.lang = item.code;
			group.append(img);
		}
		else {
			const text = document.createElement('span');

			text.className = 'flag-text';
			text.textContent = item.text;
			group.append(text);
		}
	}

	if (plan.more) {
		const more = document.createElement('span');

		more.className = 'flag-more';
		more.textContent = `+${plan.more}`;
		group.append(more);
	}

	return group;
}
