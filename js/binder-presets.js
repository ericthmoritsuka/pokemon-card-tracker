// Quick picks for a new binder (DESIGN.md section 11, "No rings, ever"):
// the common ringless zip binders, each filling in the grid and the page
// count, plus Custom for anything else.
//
// A page is one side of a sheet, as in js/binders.js: a binder of 20
// double-sided sheets has 40 pages. So the 9-pocket zip (3 x 3, 20 sheets)
// holds 40 x 9 = 360 cards and the 12-pocket (3 x 4) 40 x 12 = 480. The
// 4-pocket's 20 sheets (160 cards) are this file's assumption: DESIGN.md
// names its grid only.
//
// Pure data and functions, plus presetPicker() for the binder form, which
// needs a DOM.

export const PRESETS = [
	{cols: 2, id: '4-pocket', label: '4-pocket', page_count: 40, rows: 2, sheets: 20},
	{cols: 3, id: '9-pocket-zip', label: '9-pocket zip', page_count: 40, rows: 3, sheets: 20},
	{cols: 4, id: '12-pocket', label: '12-pocket', page_count: 40, rows: 3, sheets: 20},
];

export const CUSTOM = 'custom';

export const presetById = (id) => PRESETS.find((preset) => preset.id === id) || null;

export const presetCards = (preset) => preset.rows * preset.cols * preset.page_count;

// "3 x 3, 20 double-sided pages, 360 cards"
export const presetSummary = (preset) => `${preset.rows} x ${preset.cols}, ${preset.sheets} double-sided pages, ${presetCards(preset)} cards`;

// The fields a preset fills in: {rows, cols, page_count, preset}.
export function presetFields(id) {
	const preset = presetById(id);

	return preset ? {cols: preset.cols, page_count: preset.page_count, preset: preset.id, rows: preset.rows} : {preset: CUSTOM};
}

// The preset whose grid and page count match the fields, or "custom".
export function presetFor({cols, page_count: pageCount, rows}) {
	const match = PRESETS.find((preset) => preset.rows === Number(rows) && preset.cols === Number(cols) && preset.page_count === Number(pageCount));

	return match ? match.id : CUSTOM;
}

// The quick picks as a row of toggle buttons. onPick(fields) runs with
// presetFields(id) when one is tapped (Custom passes only {preset}, so the
// form keeps what it has and the person sets the rest). set(fields) marks
// the matching pick after the form changes by hand. Returns {element, set}.
export function presetPicker({onPick, value = null}) {
	const element = document.createElement('div');

	element.className = 'binder-presets';
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', 'Binder size');

	const buttons = [...PRESETS, {id: CUSTOM, label: 'Custom'}].map((preset) => {
		const button = document.createElement('button');
		const name = document.createElement('span');

		button.type = 'button';
		button.className = 'binder-preset';
		button.dataset.preset = preset.id;
		name.className = 'binder-preset-name';
		name.textContent = preset.label;
		button.append(name);

		if (preset.rows) {
			const detail = document.createElement('span');

			detail.className = 'binder-preset-detail';
			detail.textContent = `${preset.rows} x ${preset.cols} · ${presetCards(preset)} cards`;
			button.append(detail);
			button.setAttribute('aria-label', `${preset.label}: ${presetSummary(preset)}`);
		}
		else {
			button.setAttribute('aria-label', 'Custom: set the grid and pages yourself');
		}

		button.addEventListener('click', () => {
			mark(preset.id);
			onPick(presetFields(preset.id));
		});

		return button;
	});

	function mark(id) {
		for (const button of buttons) {
			button.setAttribute('aria-pressed', String(button.dataset.preset === id));
		}
	}

	element.append(...buttons);
	mark(value);

	return {
		element,
		set: (fields) => mark(presetFor(fields)),
	};
}
