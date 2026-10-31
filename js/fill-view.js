// "Fill placeholders" on a binder screen and on the Binders list
// (js/placeholder-fill.js; Eric, 2026-10-31): a button, then a preview
// ("212 cards go into 4 binders; 18 placeholders have no copy yet."), then
// the fill, with Undo on the toast.

import {errorText, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {UNDO_MS} from './reorder.js';
import {toast} from './shell.js';
import {fillNow, previewFill, undoFill} from './placeholder-fill.js';

// The preview's sentence. binderId set: one binder, "this binder". When
// some pockets name no language and copies in several languages fit them
// (plan.unknownLanguage), a second sentence says how many were a guess.
export function previewText(plan, {binderId = null} = {}) {
	const n = plan.rows.length;
	const waiting = plan.waiting ? `${plural(plan.waiting, 'placeholder has', 'placeholders have')} no copy yet.` : '';

	if (!n) {
		return `No card you own waits for ${binderId ? 'this binder\'s' : 'these'} placeholders.${waiting ? ` ${waiting}` : ''}`;
	}

	const where = binderId ? 'this binder' : plural(plan.binders, 'binder', 'binders');
	const goes = `${n === 1 ? '1 card goes' : `${formatCount(n)} cards go`} into ${where}`;
	const text = waiting ? `${goes}; ${waiting.charAt(0).toLowerCase()}${waiting.slice(1)}` : `${goes}.`;
	const unknown = plan.unknownLanguage || 0;

	return unknown ? `${text} ${unknown === 1 ? '1 pocket has' : `${formatCount(unknown)} pockets have`} no language saved, so the language of ${unknown === 1 ? 'its copy' : 'their copies'} is a guess (the binder's most common language, when it has one).` : text;
}

// The toast after a fill: "212 cards went into binders."
export const filledText = (n, {binderId = null} = {}) => (binderId
	? `${n === 1 ? '1 card' : `${formatCount(n)} cards`} went into this binder.`
	: `${n === 1 ? '1 card went into a binder' : `${formatCount(n)} cards went into binders`}.`);

// {button, box, show(count)}: the button and where its preview opens.
// show(count) hides the button when there are no placeholders (count 0).
// binderId null fills every hand-made binder.
export function fillPanel({binderId = null} = {}) {
	const suffix = binderId ? 'binder' : 'all';
	const button = h('button', {hidden: true, id: `fill-placeholders-${suffix}`, type: 'button'}, 'Fill placeholders');
	const box = h('div', {'aria-live': 'polite', class: 'fill-box', id: `fill-box-${suffix}`});
	let busy = false;

	const close = () => {
		box.replaceChildren();
		busy = false;
		button.disabled = false;
	};

	button.addEventListener('click', async () => {
		if (busy) {
			return;
		}

		busy = true;
		button.disabled = true;
		box.replaceChildren(h('p', {class: 'muted'}, 'Looking for cards you own...'));

		let plan;

		try {
			plan = await previewFill({binderId});
		}
		catch (err) {
			box.replaceChildren(h('p', {role: 'alert'}, `Could not work it out. ${errorText(err)}`));
			busy = false;
			button.disabled = false;

			return;
		}

		const cancel = h('button', {id: `fill-cancel-${suffix}`, onclick: close, type: 'button'}, plan.rows.length ? 'Cancel' : 'Close');
		const go = plan.rows.length ? h('button', {class: 'primary', id: `fill-go-${suffix}`, type: 'button'}, 'Fill') : null;

		box.replaceChildren(
			h('p', {id: `fill-preview-${suffix}`}, previewText(plan, {binderId})),
			h('div', {class: 'actions'}, ...[go, cancel].filter(Boolean))
		);

		if (typeof box.scrollIntoView === 'function') {
			box.scrollIntoView({block: 'nearest'});
		}

		if (!go) {
			return;
		}

		go.addEventListener('click', async () => {
			go.disabled = true;
			cancel.disabled = true;

			let result;

			try {
				result = await fillNow({binderId});
			}
			catch (err) {
				go.disabled = false;
				cancel.disabled = false;
				box.append(h('p', {role: 'alert'}, `Could not fill them. Nothing was changed. ${errorText(err)}`));

				return;
			}

			close();

			const {done} = result;

			toast(done.length ? filledText(done.length, {binderId}) : 'Nothing went in: those cards were placed since.', done.length ? {
				action: () => undoFill(done)
					.then((n) => toast(n === done.length ? 'Placeholders back.' : `${plural(n, 'placeholder', 'placeholders')} back; the other pockets changed since.`))
					.catch((err) => toast(`Could not undo. ${errorText(err)}`)),
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			} : {});
		});
	});

	return {
		box,
		button,
		show(count) {
			button.hidden = !count;

			if (!count && !busy) {
				box.replaceChildren();
			}
		},
	};
}
