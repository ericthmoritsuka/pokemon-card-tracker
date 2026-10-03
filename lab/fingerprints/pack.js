// The packed fingerprint index, written by build-index.mjs and read by
// matcher.js (the same file in Node and in the browser).
//
// Layout, little endian:
//
// | Bytes | What |
// | --- | --- |
// | 4 | `PCFP` |
// | 4 | Header length in bytes (u32) |
// | header | JSON, UTF-8, padded with spaces to a multiple of 4 |
// | N | Catalog per card (u8, index into header.catalogs) |
// | N | Flags per card (u8; 1: full art) |
// | 2N | Set per card (u16, index into header.sets) |
// | 4N | Artwork group per card (u32: the index of the group's first card) |
// | per field | Each field of header.fields in order: `art`, `card` as u32 words, `color` as i8 |
//
// The header holds the set ids and their series (`sets`, `series`), the card numbers (`localIds`, joined by `|`, in card
// order), the ids that are not `<set>-<localId>` (`oddIds`, by card index),
// the fields and their sizes, the weights the matcher uses, and when and
// from what the index was built. Cards are sorted by catalog and set, so
// `localIds` and the columns compress well when the file is gzipped.

const MAGIC = 'PCFP';

export function packIndex({header, cards, fields}) {
	const n = cards.length;
	const enc = new TextEncoder();
	let json = JSON.stringify({...header, count: n});

	while ((enc.encode(json).length + 8) % 4) {
		json += ' ';
	}

	const head = enc.encode(json);
	const fieldBytes = Object.values(fields).reduce((sum, f) => sum + f.bytes, 0);
	const total = 8 + head.length + n * (1 + 1 + 2 + 4) + n * fieldBytes;
	const buffer = new ArrayBuffer(total + ((4 - (total % 4)) % 4));
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);

	bytes.set(enc.encode(MAGIC), 0);
	view.setUint32(4, head.length, true);
	bytes.set(head, 8);

	let o = 8 + head.length;

	for (let i = 0; i < n; i++) {
		bytes[o + i] = cards[i].catalog;
		bytes[o + n + i] = cards[i].flags;
	}

	o += 2 * n;

	for (let i = 0; i < n; i++) {
		view.setUint16(o + i * 2, cards[i].set, true);
	}

	o += 2 * n;

	for (let i = 0; i < n; i++) {
		view.setUint32(o + i * 4, cards[i].group, true);
	}

	o += 4 * n;

	for (const [name, f] of Object.entries(fields)) {
		for (let i = 0; i < n; i++) {
			bytes.set(new Uint8Array(cards[i][name].buffer, cards[i][name].byteOffset, f.bytes), o + i * f.bytes);
		}

		o += n * f.bytes;
	}

	return new Uint8Array(buffer, 0, total);
}

// The index as typed-array views over one buffer (no copies).
export function unpackIndex(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	// Views need an aligned offset: copy when the bytes do not start on one.
	const buffer = bytes.byteOffset % 4 ? bytes.slice().buffer : bytes.buffer;
	const base = bytes.byteOffset % 4 ? 0 : bytes.byteOffset;
	const view = new DataView(buffer, base);

	if (new TextDecoder().decode(new Uint8Array(buffer, base, 4)) !== MAGIC) {
		throw new Error('Not a fingerprint index.');
	}

	const headLength = view.getUint32(4, true);
	const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, base + 8, headLength)));
	const n = header.count;
	let o = base + 8 + headLength;
	const catalog = new Uint8Array(buffer, o, n);
	const flags = new Uint8Array(buffer, o + n, n);

	o += 2 * n;

	// The u16 and u32 columns start on even and multiple-of-4 offsets, since
	// the header is padded and the two u8 columns add 2N.
	const set = new Uint16Array(buffer.slice(o, o + 2 * n));

	o += 2 * n;

	const group = new Uint32Array(buffer.slice(o, o + 4 * n));

	o += 4 * n;

	const fields = {};

	for (const [name, f] of Object.entries(header.fields)) {
		fields[name] = f.type === 'i8' ? new Int8Array(buffer, o, n * f.bytes) : new Uint32Array(buffer.slice(o, o + n * f.bytes));
		o += n * f.bytes;
	}

	const localIds = header.localIds.split('|');
	const odd = header.oddIds || {};

	return {
		catalog,
		count: n,
		fields,
		flags,
		group,
		header,
		// The card at index i, as {id, catalog, set, full, image}: image is
		// its TCGdex image base URL (add /low.webp).
		card(i) {
			const setId = header.sets[set[i]];
			const lang = header.catalogs[catalog[i]];

			return {
				catalog: lang,
				full: Boolean(flags[i] & 1),
				id: odd[i] || `${setId}-${localIds[i]}`,
				image: `https://assets.tcgdex.net/${lang}/${header.series[set[i]]}/${setId}/${localIds[i] || (odd[i] || '').split('-').pop()}`,
				set: setId,
			};
		},
		set,
	};
}
