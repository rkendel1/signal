import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as wasm from '../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec.js';
import { GhostpostUnicodeDecoder, ghostpostEncoder, initGhostpostCodec } from '../src/codecs/ghostpost-unicode.ts';
import { InvisibleUnicodeDetector } from '../src/codecs/invisible-unicode.ts';

initGhostpostCodec();
const dec = new GhostpostUnicodeDecoder();
const fx = JSON.parse(readFileSync(new URL('./fixtures/ghostpost-369220a.json', import.meta.url), 'utf8'));

test('cross-implementation: Signal build encodes byte-identically to original Ghostpost WASM', () => {
	for (const c of fx.cases) {
		let mine: string;
		if (c.kind === 'text') mine = wasm.encode(c.carrier, c.secret);
		else if (c.kind === 'reference') mine = wasm.encode_reference('ref carrier', c.refType, c.refId, c.metadata);
		else if (c.kind === 'secure_note') mine = wasm.encode_secure_note('note carrier', c.noteId, c.password, c.metadata);
		else mine = wasm.encode_ai_prompt('ai carrier', c.aiType, c.prompt, '', '');
		assert.equal(mine, c.encoded, `${c.kind} ${c.carrier ?? c.refId ?? ''}`);
	}
});

test('cross-implementation: content produced by original Ghostpost decodes through SignalDecoder', () => {
	for (const c of fx.cases) {
		const [s] = dec.detect({ text: c.encoded });
		assert.ok(s?.ok, `${c.kind}: ${s?.error}`);
		if (c.kind === 'text') {
			assert.equal(s.payload!.text, c.secret);
			assert.equal(s.payload!.compressed, Buffer.byteLength(c.secret) >= 1000);
		}
		if (c.kind === 'reference') assert.equal(s.payload!.refId, c.refId);
		if (c.kind === 'secure_note') assert.equal(s.payload!.noteId, 'note-1');
		if (c.kind === 'ai_prompt') assert.equal(s.payload!.aiType, 'poet');
		// Legacy decode() path is preserved for existing clients.
		if (c.kind === 'text') assert.equal(wasm.decode(c.encoded), c.secret);
	}
});

test('spans point at the envelope in the carrier (UTF-16 offsets, astral chars before it)', () => {
	const enc = ghostpostEncoder.encodeText('🙂🙂 carrier', 'x');
	const [s] = dec.detect({ text: enc });
	const slice = enc.slice(s.span![0], s.span![1]);
	assert.equal(slice[0], '﻿');
	assert.equal(slice.at(-1), '﻿');
});

test('round trips: unicode, empty secret carriers, compression boundary', () => {
	for (const secret of ['a', 'Grüße 👨‍👩‍👧 مرحبا', 'y'.repeat(999), 'y'.repeat(1000), JSON.stringify({ deep: { n: [1, 2, 3] } })]) {
		const [s] = dec.detect({ text: ghostpostEncoder.encodeText('carrier', secret) });
		assert.equal(s.payload!.text, secret);
	}
});

test('corruption: odd symbol insertion is detected; truncation errors; no panics', () => {
	const enc = ghostpostEncoder.encodeText('carrier text', 'hello world');
	const i = enc.indexOf('﻿') + 5;
	const injected = enc.slice(0, i) + '​' + enc.slice(i);
	const [a] = dec.detect({ text: injected });
	assert.equal(a.ok, false);
	assert.match(a.error!, /odd symbol count/);
	// Remove the closing delimiter: no envelope.
	assert.deepEqual(dec.detect({ text: enc.slice(0, enc.lastIndexOf('﻿')) }), []);
	// Truncate inside the envelope but keep framing.
	const inner = enc.split('﻿')[1];
	const [b] = dec.detect({ text: `x﻿${inner.slice(0, 6)}﻿y` });
	assert.equal(b.ok, false);
});

test('known limitation: an even number of injected symbols yields a wrong payload (v1 has no checksum)', () => {
	const enc = ghostpostEncoder.encodeText('carrier text', 'hello world');
	const i = enc.indexOf('﻿') + 5;
	const twice = enc.slice(0, i) + '​​' + enc.slice(i);
	const [s] = dec.detect({ text: twice });
	// Either it fails to parse or decodes to something else — it can never be trusted as the original.
	assert.ok(!s.ok || s.payload!.text !== 'hello world');
	assert.ok(s.warnings!.some((w) => /no integrity check/.test(w)));
});

test('marker dispatch: unimplemented markers are reported, not misdecoded', () => {
	const b64 = Buffer.from([0x06, 1, 2, 3]).toString('base64').replace(/=+$/, '');
	const Z = ['⁠', '​', '‌', '‍', '‎', '‏', '‭', '‬'];
	const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const inv = [...b64].map((c) => { const k = A.indexOf(c); return Z[k >> 3] + Z[k & 7]; }).join('');
	const [s] = dec.detect({ text: `a﻿${inv}﻿b` });
	assert.equal(s.kind, 'unimplemented');
	assert.equal(s.payload!.name, 'conversation');
});

test('oversized and malformed input', () => {
	const big = '﻿' + 'a'.repeat(2_000_001);
	assert.equal(dec.detect({ text: big })[0].kind, 'oversized_input');
	assert.throws(() => ghostpostEncoder.encodeReference('c', 'external_url', 'x'.repeat(70_000)), /65535/);
	assert.deepEqual(dec.detect({ text: '﻿﻿﻿' }), []);
	assert.deepEqual(dec.detect({ text: 'no signals here' }), []);
});

test('invisible-unicode detector: format-agnostic, ignores legitimate use', () => {
	const d = new InvisibleUnicodeDetector();
	assert.deepEqual(d.detect({ text: '👨‍👩‍👧‍👦 family photo, עברית‏ text' }), []);
	const tags = 'hi' + [...'secret!'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + '\u{E007F}' + 'x'.repeat(3);
	const [t] = d.detect({ text: tags + 'pad' });
	assert.ok(t, 'Unicode tag-character smuggling (not Ghostpost) is detected');
	assert.equal(t.payload!.count, 8);
	const [g] = d.detect({ text: ghostpostEncoder.encodeText('carrier', 'hello') });
	assert.ok((g.payload!.count as number) > 8);
});
