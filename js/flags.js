// Country flags for the languages a card is printed in, in place of text
// chips such as "PT" and "KO".
//
// Small bundled SVGs from flag-icons 7.5.0 (MIT, vendor/flags/LICENSE),
// never emoji, which Windows shows as letters. A flag group always carries
// the language names as its aria-label and title, so its meaning never
// depends on the picture alone. flagPlan is pure, so Node can test it.

// The app root, as js/dom.js finds it; read here so Node can load this file
// without a window.
const BASE = new URL('../', import.meta.url).pathname;

// Language -> the flag-icons file it is shown with.
export const FLAGS = {
	de: 'de',
	en: 'us',
	es: 'es',
	fr: 'fr',
	it: 'it',
	ja: 'jp',
	ko: 'kr',
	pt: 'br',
	'zh-cn': 'cn',
	'zh-tw': 'tw',
};

// Shown in this order, then any other language by its code.
const ORDER = ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw'];

export const MAX_FLAGS = 3;

const NAMES = {
	de: 'German',
	en: 'English',
	es: 'Spanish',
	fr: 'French',
	it: 'Italian',
	ja: 'Japanese',
	ko: 'Korean',
	pt: 'Portuguese',
	'zh-cn': 'Chinese (Simplified)',
	'zh-tw': 'Chinese (Traditional)',
};

export const flagLanguageName = (code) => NAMES[code] || String(code);

// The old text chip, for a language with no flag.
export const flagText = (code) => (code === 'zh-cn' ? 'CHS' : code === 'zh-tw' ? 'CHT' : String(code).toUpperCase());

export const flagSrc = (code) => (FLAGS[code] ? `${BASE}vendor/flags/${FLAGS[code]}.svg` : null);

function rank(code) {
	const i = ORDER.indexOf(code);

	return i === -1 ? ORDER.length : i;
}

// What a group of languages shows: {items: [{code, src, text}], more, label}.
// At most MAX_FLAGS items, in the fixed order, then "+N" for the rest; label
// names every language, the hidden ones too.
export function flagPlan(codes) {
	const unique = [...new Set((codes || []).filter(Boolean))]
		.sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
	const shown = unique.slice(0, MAX_FLAGS);

	return {
		items: shown.map((code) => ({code, src: flagSrc(code), text: flagText(code)})),
		label: unique.map(flagLanguageName).join(', '),
		more: unique.length - shown.length,
	};
}

// The flag group as an element. className adds to "flags"; prefix goes
// before the names in the aria-label ("Printed in Korean").
export function flagBadge(codes, {className = '', prefix = 'Printed in'} = {}) {
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
