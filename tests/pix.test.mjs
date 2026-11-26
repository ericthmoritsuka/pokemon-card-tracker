// Pix copia e cola for paying a consignor (js/pix.js): the CRC against the
// Banco Central's own example, the code's fields, and reading a Pix key the
// way people type it. No browser.
//
// Run: node --test tests/pix.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {brCode, crc16, isCpf, pixKey} from '../js/pix.js';

// The static BR Code example in the Banco Central's BR Code manual.
const BCB_EXAMPLE = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

describe('BR Code', () => {
	test('the CRC matches the Banco Central example', () => {
		assert.equal(crc16(BCB_EXAMPLE.slice(0, -4)), '1D3D');
	});

	test('a code carries the key, the amount, the name, and a valid CRC', () => {
		const code = brCode({amount: 85, key: '+5581998765432', name: 'Ana Lúcia'});

		assert.ok(code.startsWith('000201'));
		assert.ok(code.includes('0014br.gov.bcb.pix0114+5581998765432'));
		assert.ok(code.includes('540585.00'));
		assert.ok(code.includes('5909ANA LUCIA'), 'no accents, upper case');
		assert.ok(code.includes('6006RECIFE'));
		assert.equal(code.slice(-4), crc16(code.slice(0, -4)));
	});

	test('refuses a code with no key or no amount', () => {
		assert.throws(() => brCode({amount: 10, key: '', name: 'Ana'}), /no key/);
		assert.throws(() => brCode({amount: 0, key: 'a@b.co', name: 'Ana'}), /above zero/);
	});
});

describe('pixKey', () => {
	test('email and random key', () => {
		assert.deepEqual(pixKey(' Ana@Example.com '), {key: 'ana@example.com', kind: 'email', label: 'Email ana@example.com'});
		assert.equal(pixKey('46E90206-1D1D-49E6-8BFA-9162DFEFF78C').key, '46e90206-1d1d-49e6-8bfa-9162dfeff78c');
		assert.ok(pixKey('ana@').error);
	});

	test('a CPF, with or without its dots', () => {
		assert.equal(isCpf('52998224725'), true);
		assert.equal(isCpf('11111111111'), false);
		assert.deepEqual(pixKey('529.982.247-25'), {key: '52998224725', kind: 'cpf', label: 'CPF 52998224725'});
		assert.equal(pixKey('52998224725').kind, 'cpf');
		assert.match(pixKey('529.982.247-26').error, /not a valid CPF/);
	});

	test('a phone, however it is written', () => {
		assert.equal(isCpf('81998765432'), false, 'the number below is not a CPF too');
		assert.deepEqual(pixKey('81 99876-5432'), {key: '+5581998765432', kind: 'phone', label: 'Phone +55 81 998765432'});
		assert.equal(pixKey('(81) 99876-5432').key, '+5581998765432');
		assert.equal(pixKey('+55 81 99876-5432').key, '+5581998765432');
		assert.equal(pixKey('5581998765432').key, '+5581998765432');
		assert.equal(pixKey('(81) 3333-4444').key, '+558133334444');
		assert.ok(pixKey('+1 415 555 0100').error);
	});

	test('a CNPJ, and what is no key at all', () => {
		assert.deepEqual(pixKey('12.345.678/0001-95'), {key: '12345678000195', kind: 'cnpj', label: 'CNPJ 12345678000195'});
		assert.ok(pixKey('').error);
		assert.ok(pixKey('Ana').error);
		assert.ok(pixKey('12345').error);
		assert.match(pixKey('81 3876-54321').error, /neither a valid CPF nor a mobile number/);
	});
});
