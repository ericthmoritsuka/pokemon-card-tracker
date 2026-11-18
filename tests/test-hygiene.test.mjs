// Fails when a test hands page.waitForFunction an async check, or when a
// test file opens a browser without faking frankfurter.dev (tests/fake-rates.mjs).
//
// The async check: Playwright
// takes the promise an async check returns as a true answer at once, so the
// wait neither waits nor checks: the test passes whatever the page does.
// Poll an async check from Node with untilInPage (tests/poll.mjs), or give
// waitForFunction a synchronous one. Node only, no browser.
//
// Run: node --test tests/test-hygiene.test.mjs

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {basename, join, relative} from 'node:path';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

// waitForFunction( then either an inline async check, or a name whose
// definition in the same file is async (a function or a const bound to one).
const CALL = /waitForFunction\(\s*(?:(async)\b|([A-Za-z_$][\w$]*)\s*[,)])/g;

const isAsyncName = (source, name) => new RegExp(`async\\s+function\\s*\\*?\\s*${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=\\s*async\\b`).test(source);

// The line number and text of each async check passed to waitForFunction in
// `source`. A match inside a // comment is prose about the problem, not a call.
export function asyncWaits(source) {
	const found = [];

	for (const match of source.matchAll(CALL)) {
		const start = source.lastIndexOf('\n', match.index) + 1;
		const end = source.indexOf('\n', match.index);
		const lineText = source.slice(start, end === -1 ? undefined : end);

		if (source.slice(start, match.index).includes('//')) {
			continue;
		}

		if (match[1] || isAsyncName(source, match[2])) {
			found.push({line: source.slice(0, match.index).split('\n').length, text: lineText.trim()});
		}
	}

	return found;
}

// Whether `source` makes a browser context or page without faking the
// exchange rates the app fetches on every load. A file is covered when a
// line outside a // comment calls fakeRates (tests/fake-rates.mjs), it
// imports fakeServices from tests/my-cards-fixtures.mjs (a file's own
// fakeServices may not fake the rates), it routes frankfurter.dev itself, or
// it routes every outside host (a '**/*' glob, an https? pattern, or a
// predicate).
const OPENS_BROWSER = /\bnewContext\(|\bbrowser\.newPage\(/;
const COVERS_RATES = /\bfakeRates\(|import\s*\{[^}]*\bfakeServices\b[^}]*\}\s*from\s*['"]\.\/my-cards-fixtures\.mjs['"]|route\(\s*['"`]https:\/\/api\.frankfurter\.dev|route\(\s*['"`]\*\*(?:\/\*)?['"`]|route\(\s*\/\^https\?|route\(\s*\(/;

export function reachesRealRates(source) {
	const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

	return OPENS_BROWSER.test(code) && !COVERS_RATES.test(code);
}

async function sourceFiles(dir) {
	const files = [];

	for (const entry of await readdir(dir, {withFileTypes: true})) {
		const path = join(dir, entry.name);

		if (entry.isDirectory()) {
			files.push(...await sourceFiles(path));
		}
		else if (/\.(?:c|m)?js$|\.html$/.test(entry.name) && entry.name !== SELF) {
			files.push(path);
		}
	}

	return files;
}

describe('the async waitForFunction scan', () => {
	test('finds each spelling of an async check', () => {
		const cases = [
			'await page.waitForFunction(async () => (await caches.keys()).length === 1);',
			'await page.waitForFunction(\n\tasync () => true,\n);',
			'await page.waitForFunction(async function () { return true; });',
			'async function ready() { return true; }\nawait page.waitForFunction(ready, null, {timeout: 1000});',
			'const ready = async () => true;\nawait frame.waitForFunction(ready);',
		];

		for (const source of cases) {
			assert.equal(asyncWaits(source).length, 1, source);
		}
	});

	test('leaves synchronous checks and comments alone', () => {
		const cases = [
			'await page.waitForFunction(() => document.title === \'x\');',
			'const ready = () => true;\nawait page.waitForFunction(ready);',
			'// waitForFunction(async () => ...) passes at once.',
			'await page.evaluate(async () => (await caches.keys()).length);',
		];

		for (const source of cases) {
			assert.deepEqual(asyncWaits(source), [], source);
		}
	});
});

describe('the exchange rate scan', () => {
	test('finds a browser opened with no fake for frankfurter.dev', () => {
		assert.equal(reachesRealRates('const context = await browser.newContext();\nawait page.goto(url);'), true);
		assert.equal(reachesRealRates('const page = await browser.newPage();'), true);
		assert.equal(reachesRealRates('// await fakeRates(context);\nawait browser.newContext();'), true, 'a comment does not count');
		assert.equal(reachesRealRates('async function fakeServices(context) {}\nawait browser.newContext();\nawait fakeServices(context);'), true, 'a file\'s own fakeServices does not count');
	});

	test('accepts fakeRates, a frankfurter route, or a route for every outside host', () => {
		const cases = [
			'const context = await browser.newContext();\nawait fakeRates(context);',
			"import {fakeServices} from './my-cards-fixtures.mjs';\nawait browser.newContext();\nawait fakeServices(context);",
			"await browser.newContext();\nawait context.route('https://api.frankfurter.dev/**', fulfil);",
			"await browser.newContext();\nawait context.route('**/*', fulfil);",
			'await browser.newContext();\nawait context.route(/^https?:\\/\\/(?!localhost[:/])/, fulfil);',
			'await browser.newContext();\nawait context.route((url) => url.origin !== origin, fulfil);',
			'const page = await context.newPage();',
		];

		for (const source of cases) {
			assert.equal(reachesRealRates(source), false, source);
		}
	});
});

describe('tests/', () => {
	test('no test hands waitForFunction an async check', async () => {
		const offenders = [];

		for (const file of await sourceFiles(TESTS)) {
			for (const {line, text} of asyncWaits(await readFile(file, 'utf8'))) {
				offenders.push(`tests/${relative(TESTS, file)}:${line}: ${text}`);
			}
		}

		assert.deepEqual(offenders, [], `waitForFunction takes an async check's promise as true at once; poll it with untilInPage (tests/poll.mjs) instead:\n${offenders.join('\n')}`);
	});

	test('no test file opens a browser that reaches the real frankfurter.dev', async () => {
		const offenders = [];

		for (const file of await sourceFiles(TESTS)) {
			if (/\.(?:c|m)?js$/.test(file) && reachesRealRates(await readFile(file, 'utf8'))) {
				offenders.push(`tests/${relative(TESTS, file)}`);
			}
		}

		assert.deepEqual(offenders, [], `The app fetches exchange rates on every load; call fakeRates(context) from tests/fake-rates.mjs on each context these files make:\n${offenders.join('\n')}`);
	});
});
