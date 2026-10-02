// The scanner's sheets (plans/design-review.md, "Scan: Confirm Sheet" and
// "Scan: Done Sheet"): the confirm sheet for one tray card, the Done sheet
// for the session, and Set for all. Each builder takes the view's context
// (js/scan/view.js) and returns {el, refresh}; the view calls refresh after
// every change, so a sheet always shows the session as it is.

import {cardImage, languageLabel} from '../catalog.js';
import {cardArt} from '../catalog-views.js';
import {h} from '../dom.js';
import {flagBadge, flagLanguageName} from '../flags.js';
import {SearchHint, searchCards, variantLabel} from '../wishlist.js';
import {cluesOf, rankCards} from './evidence.js';
import {findVariant, finishOptions} from './finish.js';
import {
	blocker,
	canSave,
	CONDITIONS,
	doneSummary,
	findItem,
	languageChoices,
	lookReason,
	needsLook,
	ownedFor,
	quantity,
	readLine,
	searchPrefill,
	sessionFinishes,
	setForAllPreview,
	wishLine,
	wishMarks,
} from './session.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ordinal = (n) => {
	const tens = n % 100;

	if (tens >= 11 && tens <= 13) {
		return `${n}th`;
	}

	return `${n}${{1: 'st', 2: 'nd', 3: 'rd'}[n % 10] || 'th'}`;
};

const langName = (code) => flagLanguageName(code) || languageLabel(code);

// The language chips show the first few; the rest sit behind "More".
const FIRST_CHIPS = 4;

function chip({label, pressed, onclick, id, extra = null}) {
	return h('button', {'aria-pressed': String(Boolean(pressed)), class: 'scan-chip', id, onclick, type: 'button'}, extra, label);
}

function sheetHeader(title, onClose, id) {
	return h('div', {class: 'scan-sheet-head'},
		h('span', {'aria-hidden': 'true', class: 'scan-sheet-grip'}),
		h('h2', {class: 'scan-sheet-title', id}, title),
		h('button', {class: 'scan-text-button', id: 'scan-sheet-close', onclick: onClose, type: 'button'}, 'Close')
	);
}

// ------------------------------------------------------------ the confirm sheet

export function confirmSheet(ctx, itemId) {
	const titleId = 'scan-confirm-title';
	const body = h('div', {class: 'scan-sheet-body'});
	const searchBox = h('input', {
		'aria-label': 'Card name or number',
		autocomplete: 'off',
		class: 'scan-search-input',
		enterkeyhint: 'search',
		id: 'scan-search',
		placeholder: 'Name or number, for example Pikachu 25/165',
		type: 'search',
	});
	const searchStatus = h('p', {'aria-live': 'polite', class: 'scan-muted', id: 'scan-search-status'});
	const searchResults = h('ul', {class: 'scan-results', id: 'scan-search-results'});
	const searchPanel = h('form', {class: 'scan-search', hidden: true, id: 'scan-search-panel', onsubmit: (event) => {
		event.preventDefault();
		runSearch();
	}},
	h('label', {class: 'scan-label', for: 'scan-search'}, 'Search the catalog'),
	h('div', {class: 'scan-search-row'}, searchBox, h('button', {class: 'scan-button', id: 'scan-search-go', type: 'submit'}, 'Search')),
	searchStatus,
	searchResults);
	let showOthers = false;
	let moreLanguages = false;

	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-confirm', id: 'scan-confirm', role: 'dialog'},
		sheetHeader('Check this card', () => ctx.closeSheet(), titleId),
		body,
		searchPanel
	);

	// Search results, ordered by how well each fits what the read found
	// (the name, the total, a partly read number), so the card scanned is
	// near the top even when the name alone matches dozens.
	function byClues(item, results) {
		if (!item || !item.read) {
			return results;
		}

		const clues = {...cluesOf(item.readSetName ? {...item.read, name: null} : item.read), names: item.names || []};
		const ranked = rankCards(clues, results.map((result, index) => ({...result, index, official: result.official ? String(result.official) : null})));

		return ranked.sort((a, b) => b.score - a.score || a.index - b.index);
	}

	let searchRun = 0;

	async function runSearch() {
		const item = findItem(ctx.session, itemId);
		const lang = (item && item.language) || 'en';
		const text = searchBox.value;
		const run = ++searchRun;

		searchStatus.textContent = 'Searching.';

		try {
			const {results} = await searchCards(text, lang);

			if (run !== searchRun) {
				return;
			}

			const ordered = byClues(item, results);

			searchStatus.textContent = ordered.length ? `${plural(ordered.length, 'card')} found in ${langName(lang)}.` : `No card found in ${langName(lang)}.`;
			searchResults.replaceChildren(...ordered.slice(0, 12).map((result) => h('li', null,
				h('button', {class: 'scan-result', 'data-card': result.id, onclick: () => {
					ctx.chooseCard(itemId, {...result, reasons: ['search'], score: 0});
					searchPanel.hidden = true;
				}, type: 'button'},
				cardArt({name: result.name, number: result.localId, setName: result.setName}, cardImage(result.image, 'low')),
				h('span', {class: 'scan-result-text'}, result.name, h('small', null, `${result.localId}${result.official ? `/${result.official}` : ''} · ${result.setName || result.setId}`))
				))));
		}
		catch (err) {
			if (run !== searchRun) {
				return;
			}

			searchResults.replaceChildren();
			searchStatus.textContent = err instanceof SearchHint ? err.message : navigator.onLine === false ? 'Searching needs a connection for cards not on this phone yet.' : 'The search did not work. Try again.';
		}
	}

	// Candidates as the person types, a moment after the last key.
	let typing = null;

	searchBox.addEventListener('input', () => {
		clearTimeout(typing);

		if (searchBox.value.trim().length >= 2) {
			typing = setTimeout(runSearch, 350);
		}
	});

	// A card the read could not settle (no card good enough to show as the
	// answer: session.js isLead) opens with the search showing, filled with
	// the best name read, beside the candidates to pick from, so a poor
	// photo still ends in a saved card within a few taps.
	let seeded = false;

	function seedSearch(item) {
		if (seeded || item.sure || item.confirmed || !item.read || item.card || item.status !== 'ready') {
			return;
		}

		seeded = true;
		searchPanel.hidden = false;

		const prefill = searchPrefill(item);

		if (prefill) {
			searchBox.value = prefill;
			runSearch();
		}
	}

	function candidateButton(item, candidate) {
		const chosen = item.card && item.card.id === candidate.id && item.card.lang === candidate.lang;

		return h('button', {
			'aria-label': `${candidate.name}, ${candidate.setName || candidate.setId}, ${candidate.localId}${candidate.official ? ` of ${candidate.official}` : ''}`,
			'aria-pressed': String(Boolean(chosen)),
			class: 'scan-candidate',
			'data-card': candidate.id,
			onclick: () => ctx.chooseCard(itemId, candidate),
			type: 'button',
		},
		cardArt({name: candidate.name, number: candidate.localId, setName: candidate.setName}, cardImage(candidate.image, 'low')),
		h('span', {class: 'scan-candidate-set'}, candidate.setCode || candidate.setName || candidate.setId));
	}

	// The chosen card, or the top three when the match is not sure (or the
	// person asked to see the others). A card picked from the search is shown
	// first even though the match did not find it.
	function shownCandidates(item, others) {
		const chosen = item.card ? item.candidates.find((c) => c.id === item.card.id) || {...item.card, reasons: []} : null;

		if (showOthers || !item.sure) {
			return chosen && !others.includes(chosen) ? [chosen, ...others.slice(0, 2)] : others;
		}

		return chosen ? [chosen] : [];
	}

	function cardBlock(item) {
		const reason = blocker(item);
		const photo = ctx.photoUrl(item.id);
		const others = item.candidates.slice(0, 3);
		const card = item.card;
		const head = h('div', {class: 'scan-compare'},
			h('figure', {class: 'scan-photo'},
				photo ? h('img', {alt: 'Your photo of the card', src: photo}) : h('span', {class: 'scan-tile-blank'}),
				h('figcaption', null, 'Your photo')),
			...shownCandidates(item, others).map((candidate) => candidateButton(item, candidate))
		);

		const lines = [];

		if (card) {
			lines.push(h('p', {class: 'scan-card-name', id: 'scan-card-name'}, card.name));
			lines.push(h('p', {class: 'scan-muted', id: 'scan-card-set'}, `${card.localId}${card.official ? `/${card.official}` : ''} · ${card.setName || card.setId}${card.setCode ? ` (${card.setCode})` : ''}`));
		}
		else if (reason === 'reading' || reason === 'matching') {
			lines.push(h('p', {class: 'scan-card-name'}, reason === 'reading' ? 'Reading the card.' : 'Looking it up.'));
		}
		else if (reason === 'waiting') {
			lines.push(h('p', {class: 'scan-card-name'}, 'Waiting for signal'));
			lines.push(h('p', {class: 'scan-muted'}, item.waitingFor === 'ocr'
				? 'The reader is not on this phone yet. This card is read as soon as there is a connection.'
				: 'This card\'s set is not on this phone yet. It is looked up as soon as there is a connection.'));
		}
		else if (item.candidates.length) {
			lines.push(h('p', {class: 'scan-card-name'}, 'Which card is it?'));
		}
		else {
			lines.push(h('p', {class: 'scan-card-name'}, 'No card found'));
		}

		const look = needsLook(item) ? lookReason(item) : null;
		const readText = !item.sure && !item.confirmed ? readLine(item.read, {setName: item.readSetName}) : null;

		if (readText && (look || !card)) {
			lines.push(h('p', {class: 'scan-read-line', id: 'scan-read'}, readText));
		}

		if (look) {
			lines.push(h('p', {class: 'scan-why', id: 'scan-why', role: 'status'}, h('span', {'aria-hidden': 'true', class: 'scan-why-mark'}, '?'), ' ', look));
		}
		else if (card && (item.sure || item.confirmed)) {
			lines.push(h('p', {class: 'scan-sure', id: 'scan-sure'}, item.confirmed ? 'Checked by you' : 'Sure match'));
		}

		const buttons = [];

		if (card && reason === 'unsure') {
			buttons.push(h('button', {class: 'scan-button scan-primary', id: 'scan-this-card', onclick: () => ctx.chooseCard(itemId, null), type: 'button'}, 'This is the card'));
		}

		if (card && !showOthers && item.candidates.length > 1 && item.sure) {
			buttons.push(h('button', {class: 'scan-button', id: 'scan-not-this', onclick: () => {
				showOthers = true;
				refresh();
			}, type: 'button'}, 'Not this card'));
		}

		buttons.push(h('button', {class: 'scan-button', id: 'scan-open-search', onclick: () => {
			searchPanel.hidden = !searchPanel.hidden;

			if (!searchPanel.hidden) {
				searchBox.focus();
			}
		}, type: 'button'}, 'Search'));

		return [head, h('div', {class: 'scan-card-lines'}, ...lines), h('div', {class: 'scan-row'}, ...buttons)];
	}

	function languageBlock(item) {
		const choices = languageChoices(item);
		const shown = moreLanguages ? choices : choices.slice(0, FIRST_CHIPS);

		if (item.language && !shown.includes(item.language)) {
			shown.push(item.language);
		}

		const source = item.languageBy === 'read'
			? 'read from the card'
			: item.languageBy === 'hand'
				? 'picked by you'
				: item.languageBy === 'all'
					? 'set for all'
					: 'not sure, pick one';

		return h('fieldset', {class: 'scan-field', id: 'scan-language'},
			h('legend', null, 'Printed in ', h('span', {class: 'scan-source', id: 'scan-language-source'}, source)),
			h('div', {class: 'scan-chips'},
				...shown.map((code) => chip({
					extra: flagBadge([code], {prefix: ''}),
					id: `scan-lang-${code}`,
					label: langName(code),
					onclick: () => ctx.setLanguage(itemId, code),
					pressed: item.language === code,
				})),
				moreLanguages ? null : h('button', {class: 'scan-chip', id: 'scan-lang-more', onclick: () => {
					moreLanguages = true;
					refresh();
				}, type: 'button'}, 'More')
			)
		);
	}

	function finishBlock(item) {
		const options = finishOptions(item.variants);

		if (!item.card) {
			return null;
		}

		if (item.variants === null) {
			return h('div', {class: 'scan-field', id: 'scan-finish'}, h('p', {class: 'scan-label'}, 'Finish'), h('p', {class: 'scan-muted'}, item.status === 'waiting' ? 'Its finishes load when there is signal.' : 'Loading its finishes.'));
		}

		if (!options.length) {
			return h('div', {class: 'scan-field', id: 'scan-finish'}, h('p', {class: 'scan-label'}, 'Finish'), h('p', {class: 'scan-muted'}, 'TCGdex lists no printings for this card, so it is saved without a finish.'));
		}

		return h('fieldset', {class: 'scan-field', id: 'scan-finish'},
			h('legend', null, 'Finish'),
			h('div', {class: 'scan-chips'}, ...options.map((option) => chip({
				id: `scan-finish-${option.variantId}`,
				label: option.label,
				onclick: () => ctx.setFinish(itemId, option.variantId),
				pressed: item.variantId === option.variantId,
			})))
		);
	}

	function conditionBlock(item) {
		const select = h('select', {'aria-label': 'Condition', class: 'scan-select', id: 'scan-condition', onchange: () => ctx.setCondition(itemId, select.value || null)},
			h('option', {value: ''}, 'Not set'),
			...CONDITIONS.map((condition) => h('option', {value: condition}, condition)));

		select.value = item.condition || '';

		return h('div', {class: 'scan-field scan-condition'}, h('label', {class: 'scan-label', for: 'scan-condition'}, 'Condition'), select);
	}

	function ownedLines(item) {
		const owned = ownedFor(item, ctx.owned);
		const marks = wishMarks(item, ctx.family);
		const lines = [];

		if (owned.total) {
			const byLanguage = new Map();

			for (const entry of owned.entries) {
				const variant = findVariant(item.variants, entry.variant_id);
				const key = `${entry.language}|${variant ? variantLabel(variant) : ''}`;

				byLanguage.set(key, (byLanguage.get(key) || 0) + 1);
			}

			const parts = [...byLanguage.entries()].map(([key, n]) => {
				const [lang, finish] = key.split('|');

				return `${n} ${langName(lang)}${finish ? ` ${finish}` : ''}`;
			});
			const next = quantity(ctx.session, item, ctx.owned);

			lines.push(h('p', {id: 'scan-owned-line'}, `You have ${parts.join(', ')}.${item.language && owned.inLanguage ? ` This adds a ${ordinal(next)} in ${langName(item.language)}.` : ''}`));
		}
		else if (item.card) {
			const inTray = quantity(ctx.session, item, ctx.owned);

			lines.push(h('p', {id: 'scan-owned-line'}, inTray > 1 ? `Not in your cards yet. This session has ${inTray}.` : 'Not in your cards yet.'));
		}

		const wish = wishLine(marks);

		if (wish) {
			const unsure = marks.some((mark) => mark.unconfirmed.length);

			lines.push(h('p', {class: 'scan-wish', id: 'scan-wish-line'}, h('span', {'aria-hidden': 'true'}, '♥ '), `${wish} card.`, unsure ? ' Check the language and finish they asked for.' : ''));
		}

		return lines.length ? h('div', {class: 'scan-frame', id: 'scan-lines'}, ...lines) : null;
	}

	function actions(item) {
		const total = ctx.session.items.length;
		const single = total === 1;
		const reason = blocker(item);
		const saveBlocked = reason !== null;
		const summary = doneSummary(ctx.session, ctx.owned);

		const save = single
			? h('button', {class: 'scan-button scan-primary scan-wide', disabled: saveBlocked, id: 'scan-save', onclick: () => ctx.save(), type: 'button'}, 'Save')
			: h('button', {class: 'scan-button scan-primary scan-wide', id: 'scan-review-done', onclick: () => ctx.openDone(), type: 'button'}, `Done · ${plural(summary.total, 'card')}`);

		const blockedText = single && saveBlocked
			? h('p', {class: 'scan-muted', id: 'scan-save-why'}, reason === 'unsure' ? 'Tap the right card before saving.' : reason === 'language' ? 'Pick the language before saving.' : reason === 'unmatched' ? 'Find the card before saving.' : reason === 'waiting' ? 'Saving waits until this card is looked up.' : 'Still working on this card.')
			: null;

		return h('div', {class: 'scan-actions'},
			h('div', {class: 'scan-row'},
				single
					? h('button', {class: 'scan-button', id: 'scan-discard', onclick: () => ctx.discard(), type: 'button'}, 'Discard')
					: h('button', {class: 'scan-button scan-danger', id: 'scan-remove', onclick: () => ctx.remove(itemId), type: 'button'}, 'Remove'),
				h('button', {class: 'scan-button', id: 'scan-next', onclick: () => ctx.closeSheet(), type: 'button'}, 'Scan next')
			),
			blockedText,
			save
		);
	}

	function refresh() {
		const item = findItem(ctx.session, itemId);

		if (!item) {
			ctx.closeSheet();

			return;
		}

		seedSearch(item);
		body.replaceChildren(
			...cardBlock(item),
			languageBlock(item),
			finishBlock(item),
			conditionBlock(item),
			ownedLines(item),
			actions(item)
		);
	}

	refresh();

	return {el, itemId, refresh};
}

// ------------------------------------------------------------ the Done sheet

export function doneSheet(ctx) {
	const titleId = 'scan-done-title';
	const body = h('div', {class: 'scan-sheet-body'});
	let skipOwned = false;

	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-done', id: 'scan-done', role: 'dialog'},
		sheetHeader('Save this session', () => ctx.closeSheet(), titleId),
		body
	);

	function refresh() {
		const summary = doneSummary(ctx.session, ctx.owned);
		const firstLook = ctx.session.items.find((item) => needsLook(item));
		const languages = summary.byLanguage.map(([lang, n]) => `${String(lang).toUpperCase()} ${n}`).join(' · ');
		const saving = summary.savable - (skipOwned ? summary.owned : 0);
		const rows = [h('p', {class: 'scan-done-count', id: 'scan-done-count'}, `${plural(summary.total, 'card')}${languages ? ` · ${languages}` : ''}`)];

		if (summary.look) {
			rows.push(h('div', {class: 'scan-done-row scan-done-look'},
				h('span', {id: 'scan-done-look'}, h('span', {'aria-hidden': 'true', class: 'scan-why-mark'}, '!'), ` ${summary.look} ${summary.look === 1 ? 'needs' : 'need'} a look`),
				h('button', {class: 'scan-button', id: 'scan-done-review', onclick: () => ctx.openItem(firstLook.id), type: 'button'}, 'Review')));
		}

		if (summary.busy) {
			rows.push(h('p', {class: 'scan-muted', id: 'scan-done-busy'}, `Still reading ${plural(summary.busy, 'card')}.`));
		}

		if (summary.waiting) {
			rows.push(h('p', {class: 'scan-muted', id: 'scan-done-waiting'}, `${plural(summary.waiting, 'card')} waiting for signal ${summary.waiting === 1 ? 'stays' : 'stay'} in the tray and can be saved later.`));
		}

		if (summary.owned) {
			rows.push(h('div', {class: 'scan-done-owned'},
				h('p', {id: 'scan-done-owned'}, `${summary.owned} you already own`),
				h('div', {class: 'scan-chips', role: 'group', 'aria-label': 'Cards you already own'},
					chip({id: 'scan-owned-extras', label: 'Add as extras', onclick: () => {
						skipOwned = false;
						refresh();
					}, pressed: !skipOwned}),
					chip({id: 'scan-owned-skip', label: 'Skip them', onclick: () => {
						skipOwned = true;
						refresh();
					}, pressed: skipOwned}))));
		}

		rows.push(h('div', {class: 'scan-done-row'},
			h('span', {class: 'scan-label'}, 'Set for all'),
			h('div', {class: 'scan-chips'},
				h('button', {class: 'scan-chip', id: 'scan-all-language', onclick: () => ctx.openSetAll('language'), type: 'button'}, 'Language'),
				h('button', {class: 'scan-chip', id: 'scan-all-finish', onclick: () => ctx.openSetAll('finish'), type: 'button'}, 'Finish'),
				h('button', {class: 'scan-chip', id: 'scan-all-condition', onclick: () => ctx.openSetAll('condition'), type: 'button'}, 'Condition'))));

		const ready = canSave(summary) && saving > 0;
		const label = summary.look || summary.busy
			? `Save ${summary.savable}, ${summary.look ? `${summary.look} ${summary.look === 1 ? 'needs' : 'need'} a look` : `${summary.busy} still reading`}`
			: `Save ${plural(saving, 'card')}`;

		rows.push(h('div', {class: 'scan-actions'},
			h('button', {class: 'scan-button', id: 'scan-discard-session', onclick: () => ctx.discard(), type: 'button'}, 'Discard session'),
			h('button', {class: 'scan-button scan-primary scan-wide', disabled: !ready, id: 'scan-save-session', onclick: () => ctx.save({skipOwned}), type: 'button'}, label)));

		body.replaceChildren(...rows);
	}

	refresh();

	return {el, refresh};
}

// ------------------------------------------------------------ Set for all

export function setAllSheet(ctx, field) {
	const titleId = 'scan-setall-title';
	const body = h('div', {class: 'scan-sheet-body'});
	let value = null;
	let picked = false;

	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-setall', id: 'scan-setall', role: 'dialog'},
		sheetHeader('Set for all', () => ctx.closeSheet(), titleId),
		body
	);

	const fieldNames = {condition: 'Condition', finish: 'Finish', language: 'Language'};

	function choices() {
		if (field === 'language') {
			return languageChoices({languageHint: 'pt'}).map((code) => ({extra: flagBadge([code], {prefix: ''}), label: langName(code), value: code}));
		}

		if (field === 'finish') {
			return sessionFinishes(ctx.session).map((finish) => ({label: `${finish.label} (${finish.count})`, value: finish.key}));
		}

		return [{label: 'Not set', value: null}, ...CONDITIONS.map((condition) => ({label: condition, value: condition}))];
	}

	function refresh() {
		const fieldChips = h('div', {class: 'scan-chips', role: 'group', 'aria-label': 'What to set'},
			...['language', 'finish', 'condition'].map((name) => chip({id: `scan-setall-field-${name}`, label: fieldNames[name], onclick: () => {
				field = name;
				value = null;
				picked = false;
				refresh();
			}, pressed: field === name})));
		const options = choices();
		const valueChips = options.length
			? h('div', {class: 'scan-chips', id: 'scan-setall-values'}, ...options.map((option) => chip({
				extra: option.extra || null,
				id: `scan-setall-${String(option.value).replace(/[^a-z0-9-]/gi, '_')}`,
				label: option.label,
				onclick: () => {
					value = option.value;
					picked = true;
					refresh();
				},
				pressed: picked && value === option.value,
			})))
			: h('p', {class: 'scan-muted'}, 'No card in the tray has its finishes yet.');
		const rows = [fieldChips, valueChips];

		if (picked) {
			const preview = setForAllPreview(ctx.session, field, value);
			const skipped = preview.skipped ? ` ${plural(preview.skipped, 'card')} ${preview.skipped === 1 ? 'has' : 'have'} no such printing and ${preview.skipped === 1 ? 'stays' : 'stay'} as ${preview.skipped === 1 ? 'it is' : 'they are'}.` : '';

			rows.push(h('p', {'aria-live': 'polite', class: 'scan-preview', id: 'scan-setall-preview'}, preview.changes
				? `Changes ${plural(preview.changes, 'card')}.${skipped}${preview.hand ? ` Keep the ${preview.hand} you set by hand?` : ''}`
				: `Nothing changes.${skipped}`));

			if (preview.changes) {
				if (preview.hand) {
					rows.push(h('div', {class: 'scan-row'},
						h('button', {class: 'scan-button', id: 'scan-setall-keep', onclick: () => ctx.applySetAll(field, value, {keepHand: true}), type: 'button'}, `Keep my ${preview.hand}`),
						h('button', {class: 'scan-button scan-primary', id: 'scan-setall-apply', onclick: () => ctx.applySetAll(field, value, {keepHand: false}), type: 'button'}, `Change all ${preview.changes}`)));
				}
				else {
					rows.push(h('button', {class: 'scan-button scan-primary scan-wide', id: 'scan-setall-apply', onclick: () => ctx.applySetAll(field, value, {keepHand: false}), type: 'button'}, `Apply to ${plural(preview.changes, 'card')}`));
				}
			}
		}

		body.replaceChildren(...rows);
	}

	refresh();

	return {el, refresh};
}
