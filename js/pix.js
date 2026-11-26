// Pix copia e cola (a static BR Code) for paying a consignor
// (plans/hotaru-consignment-plan.md, Eric 2026-11-26: "o sistema poderia
// gerar um qr code para eu pagar a pessoa"). The builder is HOTARU's
// assets/pix.js, which Eric verified end to end with Nubank on 2026-11-24;
// here it pays someone else, so the key, name, and amount are theirs.
//
// The Pix key is read the way people type it: an email, a random key, a CPF
// or CNPJ with or without dots, or a phone number with or without +55. An
// 11-digit number is a CPF only when its check digits add up; otherwise a
// mobile number (a 9 after the area code) is a phone. Whatever is read, the
// bank app shows the key holder's name before anything is paid.
//
// No DOM here. The QR is drawn by vendor/qrcode-generator-1.4.4.min.js in
// js/shop-consignment.js.

// Without accents, and only the characters the format takes.
const plain = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').trim();

// One field: the ID, its length in two digits, and the value.
function field(id, value) {
	const text = String(value);

	if (text.length > 99) {
		throw new Error(`Pix: field ${id} is longer than 99 characters.`);
	}

	return `${id}${String(text.length).padStart(2, '0')}${text}`;
}

// CRC16-CCITT (polynomial 0x1021, start 0xFFFF), as the BR Code asks.
export function crc16(text) {
	let crc = 0xffff;

	for (let i = 0; i < text.length; i++) {
		crc ^= text.charCodeAt(i) << 8;

		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
		}
	}

	return crc.toString(16).toUpperCase().padStart(4, '0');
}

// The copia e cola code. name up to 25 characters, city up to 15; amount in
// reais; txid letters and digits up to 25, *** when none.
export function brCode({amount, city = 'RECIFE', description = '', key, name, txid = '***'}) {
	if (!key) {
		throw new Error('Pix: no key.');
	}

	if (!(Number(amount) > 0)) {
		throw new Error('Pix: the amount must be above zero.');
	}

	const id = String(txid || '***');

	if (id !== '***' && !/^[A-Za-z0-9]{1,25}$/.test(id)) {
		throw new Error('Pix: the ID takes letters and digits only, up to 25.');
	}

	const account = field('00', 'br.gov.bcb.pix') + field('01', key) + (plain(description) ? field('02', plain(description).slice(0, 40)) : '');
	const body = field('00', '01')
		+ field('26', account)
		+ field('52', '0000')
		+ field('53', '986')
		+ field('54', Number(amount).toFixed(2))
		+ field('58', 'BR')
		+ field('59', plain(name).toUpperCase().slice(0, 25) || 'RECEBEDOR')
		+ field('60', plain(city).toUpperCase().slice(0, 15) || 'BRASIL')
		+ field('62', field('05', id))
		+ '6304';

	return body + crc16(body);
}

// Whether 11 digits are a CPF: its two check digits add up, and it is not
// one digit repeated.
export function isCpf(digits) {
	if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) {
		return false;
	}

	const check = (length) => {
		let sum = 0;

		for (let i = 0; i < length; i++) {
			sum += Number(digits[i]) * (length + 1 - i);
		}

		const rest = (sum * 10) % 11;

		return rest === 10 ? 0 : rest;
	};

	return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A Pix key as typed, read into the form the BR Code needs:
// {key, kind, label} with kind email, random, cpf, cnpj, or phone, or
// {error} when it cannot be told.
export function pixKey(typed) {
	const raw = String(typed || '').trim();

	if (!raw) {
		return {error: 'No Pix key.'};
	}

	if (raw.includes('@')) {
		const email = raw.toLowerCase();

		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 77
			? {key: email, kind: 'email', label: `Email ${email}`}
			: {error: `${raw} is not an email address.`};
	}

	if (UUID.test(raw.toLowerCase())) {
		return {key: raw.toLowerCase(), kind: 'random', label: `Random key ${raw.toLowerCase()}`};
	}

	if (/[^\d\s().+/-]/.test(raw)) {
		return {error: `${raw} is not a Pix key: use an email, a random key, a CPF, a CNPJ, or a phone number.`};
	}

	const digits = raw.replace(/\D/g, '');
	const phone = (national) => ({key: `+55${national}`, kind: 'phone', label: `Phone +55 ${national.slice(0, 2)} ${national.slice(2)}`});

	if (raw.startsWith('+')) {
		return /^55\d{10,11}$/.test(digits) ? phone(digits.slice(2)) : {error: `${raw} is not a Brazilian phone number.`};
	}

	if (digits.length === 14) {
		return {key: digits, kind: 'cnpj', label: `CNPJ ${digits}`};
	}

	if (digits.length === 13 && digits.startsWith('55')) {
		return phone(digits.slice(2));
	}

	// 11 digits: a CPF written as one (dots and a dash), or one whose check
	// digits add up, unless it was written as a phone, with parentheses.
	if (digits.length === 11) {
		const writtenAsCpf = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(raw);
		const writtenAsPhone = /[()]/.test(raw);

		if (writtenAsCpf || (!writtenAsPhone && isCpf(digits))) {
			return isCpf(digits) ? {key: digits, kind: 'cpf', label: `CPF ${digits}`} : {error: `${raw} is not a valid CPF.`};
		}

		return digits[2] === '9' ? phone(digits) : {error: `${raw} is neither a valid CPF nor a mobile number.`};
	}

	if (digits.length === 10) {
		return phone(digits);
	}

	return {error: `${raw} is not a Pix key: use an email, a random key, a CPF, a CNPJ, or a phone number.`};
}
