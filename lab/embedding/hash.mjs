// The app's picture match (js/scan/picture.js matchCrops) with a longer
// answer: the same crops, shifts, wide search and screening, but up to
// `top` artwork groups instead of five, so the embedding can re-rank or
// fuse with the hash's top 50. The groups and their order are the app's.

import {queryFingerprints, thumbnail, WIDE_SHIFTS} from '../../js/vision/fingerprint.js';
import {matchFingerprints} from '../../js/vision/matcher.js';
import {compactPicture, pictureVerdict, SCREEN, WIDE_CROPS} from '../../js/scan/picture.js';

const gapOf = (groups) => (groups.length > 1 ? groups[1].score - groups[0].score : groups.length ? Infinity : 0);
const scoreOf = (result) => (result.groups[0] ? result.groups[0].score : Infinity);

export function hashMatch(index, img, {top = 50} = {}) {
	const bits = {artBits: index.header.fields.art.bytes * 8, cardBits: index.header.fields.card ? index.header.fields.card.bytes * 8 : 64};
	const thumb = thumbnail(img);
	const queries = queryFingerprints(thumb, bits);
	let result = matchFingerprints(index, queries, {screen: SCREEN.base, top});
	const plain = {gap: gapOf(result.groups), groups: result.groups};

	// matchCrops widens when the plain search is not sure; with one crop,
	// the wide result replaces it when its best score is no worse.
	if (WIDE_CROPS && !pictureVerdict(compactPicture(plain)).sure) {
		const more = queryFingerprints(thumb, bits, WIDE_SHIFTS);
		const wide = matchFingerprints(index, [...queries, ...more], {screen: SCREEN.wide, top});

		if (scoreOf(wide) <= scoreOf(result)) {
			result = wide;
		}
	}

	const groups = result.groups;
	const verdict = pictureVerdict(compactPicture({gap: gapOf(groups), groups}));

	return {gap: gapOf(groups), groups, verdict};
}
