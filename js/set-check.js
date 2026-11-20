// Phone check's "A set on this phone": one set as this phone holds it, read
// only and with no request: the copies, the card index records and the set
// they name, the ring the Sets tab draws, and the saved set lists, with Copy
// for plain text to paste into a chat. On 2026-11-20 a Realme showed 57 of
// 161 owned for the 30th Celebration where two other devices showed 147
// from the same 2,208 copies, and a site-data reset fixed it before its
// data could be read. This is for reading it first next time.

import {cardIndex, catalogFor, catalogLanguage, dexPending, indexKey, savedSetList, savedSetRecord, setIdOfCard, viewingLanguage} from './catalog.js';
import {setsOwnedCount, setsOwnedIn} from './catalog-views.js';
import {listCards, ownedBySet} from './collection.js';
import {errorText, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {languageLabel, sortLanguages} from './languages.js';

// Card IDs listed in one row before "and N more".
const MAX_IDS = 12;

const idList = (ids) => {
	const sorted = [...ids].sort((a, b) => String(a).localeCompare(String(b), 'en', {numeric: true}));
	const shown = sorted.slice(0, MAX_IDS).join(', ');

	return sorted.length > MAX_IDS ? `${shown}, and ${formatCount(sorted.length - MAX_IDS)} more` : shown;
};

function age(ms) {
	const minutes = Math.floor(Math.max(0, ms) / 60000);

	if (minutes < 1) {
		return 'under a minute';
	}

	if (minutes < 60) {
		return plural(minutes, 'minute');
	}

	const hours = Math.floor(minutes / 60);

	return hours < 48 ? plural(hours, 'hour') : plural(Math.floor(hours / 24), 'day');
}

const savedWhen = (at, now) => `${new Date(at).toLocaleString()}, ${age(now - at)} ago`;

// The language a set's Sets ring is drawn in: the viewing language when the
// set is in its catalog, else the catalog's own (a Japanese set while
// viewing English shows on the Sets tab only in Japanese).
const ringLanguage = (catalog) => {
	const viewing = viewingLanguage();

	return catalogFor(viewing) === catalog ? viewing : catalogLanguage(catalog);
};

// The sets of the saved set list in `lang`, by ID.
async function listedSets(lang) {
	const hit = await savedSetList(lang).catch(() => null);
	const sets = new Map();

	for (const serie of (hit && Array.isArray(hit.data) ? hit.data : [])) {
		for (const set of serie.sets || []) {
			sets.set(set.id, set);
		}
	}

	return sets;
}

// A set's name from a card index record: in `lang`, else any language.
function recordSetName(record, lang) {
	const localizations = (record && record.localizations) || {};
	const own = localizations[lang] && localizations[lang].set_name;

	return own || Object.values(localizations).map((local) => local && local.set_name).find(Boolean) || null;
}

// Whether a copy's card is in the set: its ID begins with the set's, or its
// index record names the set. Both, so a record naming another set (which
// moves the card out of the set's ring) still shows here.
const inSet = (entry, record, setId) => setIdOfCard(entry.card_id) === setId || Boolean(record && record.set_id === setId);

// The sets this phone has copies of, by name: [{catalog, copies, key,
// label, setId}], each under the set its card ID begins with and the set
// its index record names.
export async function ownedSets() {
	const [entries, index] = await Promise.all([listCards(), cardIndex()]);
	const sets = new Map();

	for (const entry of entries) {
		const record = index.get(indexKey(entry.catalog, entry.card_id));

		for (const setId of new Set([setIdOfCard(entry.card_id), record && record.set_id])) {
			if (!setId) {
				continue;
			}

			const key = `${entry.catalog}|${setId}`;

			if (!sets.has(key)) {
				sets.set(key, {catalog: entry.catalog, copies: 0, key, name: null, setId});
			}

			const set = sets.get(key);

			set.copies++;
			set.name = set.name || (record && record.set_id === setId ? recordSetName(record, ringLanguage(entry.catalog)) : null);
		}
	}

	const lists = new Map();

	for (const set of sets.values()) {
		const lang = ringLanguage(set.catalog);

		if (!lists.has(lang)) {
			lists.set(lang, await listedSets(lang));
		}

		const listed = lists.get(lang).get(set.setId);

		set.name = (listed && listed.name) || set.name || set.setId;
		set.label = `${set.name} (${set.setId}${set.catalog === 'international' ? '' : `, ${languageLabel(catalogLanguage(set.catalog))}`}) · ${plural(set.copies, 'copy', 'copies')}`;
	}

	return [...sets.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', {numeric: true}) || a.key.localeCompare(b.key));
}

// The rows for one set, as [label, value]: what the screen's table shows
// and Copy sends, line for line.
export async function setCheckRows({catalog, setId}, {now = Date.now()} = {}) {
	const [entries, index, bySet] = await Promise.all([listCards(), cardIndex(), ownedBySet()]);
	const lang = ringLanguage(catalog);
	const listed = (await listedSets(lang)).get(setId) || null;
	const cards = new Map();
	const languages = new Map();
	let copies = 0;

	for (const entry of entries) {
		const record = index.get(indexKey(entry.catalog, entry.card_id));

		if (entry.catalog !== catalog || !inSet(entry, record, setId)) {
			continue;
		}

		copies++;

		if (!cards.has(entry.card_id)) {
			cards.set(entry.card_id, record || null);
		}

		if (!languages.has(entry.language)) {
			languages.set(entry.language, {cards: new Set(), copies: 0});
		}

		languages.get(entry.language).copies++;
		languages.get(entry.language).cards.add(entry.card_id);
	}

	const named = [...cards.values()].find((record) => record && record.set_id === setId);
	const saved = await savedSetRecord(catalogLanguage(catalog), setId).catch(() => null);
	const name = (listed && listed.name) || recordSetName(named, lang) || (saved && saved.data && saved.data.name) || setId;
	const rows = [
		['Report time', new Date(now).toLocaleString()],
		['Set', `${name} (${setId})${catalog === 'international' ? '' : `, ${languageLabel(catalogLanguage(catalog))} catalog`}`],
		['Copies', formatCount(copies)],
		['Distinct cards', formatCount(cards.size)],
	];

	for (const code of sortLanguages(languages.keys())) {
		const {cards: inLanguage, copies: count} = languages.get(code);

		rows.push([`In ${languageLabel(code)}`, `${plural(count, 'copy', 'copies')}, ${plural(inLanguage.size, 'card')}`]);
	}

	// The card index records (js/catalog.js cardIndex) and the sets they name.
	const lacking = [...cards].filter(([, record]) => !record).map(([id]) => id);
	const records = [...cards].filter(([, record]) => record);
	const namedSets = new Map();

	for (const [, record] of records) {
		const key = record.set_id || '(none)';

		namedSets.set(key, (namedSets.get(key) || 0) + 1);
	}

	const elsewhere = records.filter(([, record]) => record.set_id !== setId);
	const pending = records.filter(([, record]) => dexPending(record));
	const setOrder = [...namedSets].sort((a, b) => (b[0] === setId) - (a[0] === setId) || b[1] - a[1] || a[0].localeCompare(b[0]));

	rows.push(
		['Cards with an index record', formatCount(records.length)],
		['Cards with no index record', lacking.length ? `${formatCount(lacking.length)}: ${idList(lacking)}` : '0'],
		['Set the records name', setOrder.length ? setOrder.map(([id, count]) => `${id} (${formatCount(count)})`).join(', ') : 'No records'],
		['Records naming another set', elsewhere.length ? `${formatCount(elsewhere.length)}: ${idList(elsewhere.map(([id, record]) => `${id} (${record.set_id || 'none'})`))}` : '0'],
		['Pokémon with no Pokédex number', pending.length ? `${formatCount(pending.length)}: ${idList(pending.map(([id]) => id))}` : '0']
	);

	// The ring, from the Sets tab's own ownedBySet and setsOwnedCount.
	const counted = bySet.get(`${catalogFor(lang)}|${setId}`);
	const countedCopies = counted ? entries.filter((entry) => entry.catalog === catalog && counted.has(entry.card_id)).length : 0;
	const total = listed && listed.cardCount ? (listed.cardCount.total ?? listed.cardCount.official) : null;
	const ring = (have) => (typeof total === 'number' ? `${formatCount(have)} / ${formatCount(total)}` : `${formatCount(have)} (no saved set list in ${languageLabel(lang)} for the total)`);

	rows.push(
		['Counted in this set by the Sets tab', `${plural(counted ? counted.size : 0, 'card')}, ${plural(countedCopies, 'copy', 'copies')}`],
		[`Sets ring in ${languageLabel(lang)}`, ring(setsOwnedCount(counted, lang, 'language'))],
		['Sets ring with Any language', ring(setsOwnedCount(counted, lang, 'any'))],
		['Sets tab Owned switch', setsOwnedIn() === 'any' ? 'Any language' : `In the viewing language (${languageLabel(viewingLanguage())})`]
	);

	// The saved set record in each language the set is read in, and whether
	// it lists every owned card: a list saved before TCGdex had all of a new
	// set's cards leaves the rest off the set's page.
	const listLanguages = sortLanguages(new Set([lang, ...[...languages.keys()].filter((code) => code && catalogFor(code) === catalog)]));

	for (const code of listLanguages) {
		const hit = code === catalogLanguage(catalog) ? saved : await savedSetRecord(code, setId).catch(() => null);
		const label = `Saved set list in ${languageLabel(code)}`;

		if (!hit) {
			rows.push([label, 'Not saved on this phone']);

			continue;
		}

		if (hit.missing) {
			rows.push([label, `TCGdex had no such set when asked, ${savedWhen(hit.at, now)}`]);

			continue;
		}

		const ids = new Set(((hit.data && hit.data.cards) || []).map((card) => card && card.id));
		const unlisted = [...cards.keys()].filter((id) => !ids.has(id));

		rows.push([label, `Saved ${savedWhen(hit.at, now)}; lists ${plural(ids.size, 'card')}; ${unlisted.length ? `${formatCount(unlisted.length)} owned not listed: ${idList(unlisted)}` : 'every owned card listed'}`]);
	}

	return rows;
}

export const setCheckText = (rows) => ['Card Tracker set check', ...rows.map(([label, value]) => `${label}: ${value}`)].join('\n');

// The section for Phone check. `copyText` is Phone check's own copy, with
// its fallback for browsers that block the clipboard. Answers the element.
export function setCheckCard({copyText}) {
	const select = h('select', {disabled: true, id: 'set-check-set', onchange: () => draw()},
		h('option', {value: ''}, 'Reading the sets...'));
	const table = h('table', {class: 'results', id: 'set-check-table'});
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'set-check-status'});
	const copy = h('button', {disabled: true, id: 'set-check-copy', onclick: () => copyNow(), type: 'button'}, 'Copy');
	let choices = [];
	let rows = [];
	let turn = 0;

	async function fill() {
		try {
			choices = await ownedSets();
			select.replaceChildren(
				h('option', {value: ''}, choices.length ? 'Pick a set' : 'No copies on this phone'),
				...choices.map((set) => h('option', {value: set.key}, set.label))
			);
			select.disabled = !choices.length;
		}
		catch (err) {
			select.replaceChildren(h('option', {value: ''}, 'The sets could not be read'));
			status.textContent = errorText(err);
		}
	}

	async function draw() {
		const mine = ++turn;
		const set = choices.find((choice) => choice.key === select.value);

		rows = [];
		copy.disabled = true;
		status.textContent = '';
		table.replaceChildren();

		if (!set) {
			return;
		}

		status.textContent = 'Reading this phone...';

		try {
			const next = await setCheckRows(set);

			if (mine !== turn) {
				return;
			}

			rows = next;
			table.replaceChildren(h('tbody', null, rows.map(([label, value]) => h('tr', null, h('th', {scope: 'row'}, label), h('td', null, value)))));
			copy.disabled = false;
			status.textContent = '';
		}
		catch (err) {
			if (mine === turn) {
				status.textContent = `This set could not be read: ${errorText(err)}`;
			}
		}
	}

	async function copyNow() {
		try {
			await copyText(setCheckText(rows));
			status.textContent = 'Copied. Paste it into the chat.';
		}
		catch (err) {
			status.textContent = `Copy failed: ${errorText(err)}`;
		}
	}

	fill();

	return h('section', {class: 'card', id: 'set-check'},
		h('h2', null, 'A set on this phone'),
		h('p', {class: 'muted'}, 'What this phone holds for one set, read from this phone only: its copies, card records, Sets ring, and saved set lists. When phones disagree on a set\'s count, pick the set here on the phone that is off and tap Copy.'),
		h('label', {for: 'set-check-set'}, 'Set'),
		h('div', {class: 'select-wrap'}, select),
		table,
		h('div', {style: 'margin-top: 8px'}, copy),
		status
	);
}
