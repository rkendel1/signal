import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DetectedSignal, SignalDecoder, SignalInput } from '../contracts/types.ts';
import * as wasm from '../../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec.js';

/**
 * Codec provider `ghostpost-unicode/v1`: the extracted Ghostpost Rust/WASM codec
 * behind Signal's SignalDecoder boundary. Wire format is identical to
 * rkendel1/ghostpost@369220a, so content produced by Ghostpost decodes here.
 */
export const CODEC_ID = 'ghostpost-unicode/v1';
const MAX_INPUT_CHARS = 2_000_000;
const U16_MAX = 0xffff;

let ready = false;
export function initGhostpostCodec(): void {
	if (ready) return;
	const wasmPath = fileURLToPath(new URL('../../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec_bg.wasm', import.meta.url));
	wasm.initSync({ module: readFileSync(wasmPath) });
	ready = true;
}

interface RawEnvelope {
	start: number; end: number; marker: number | null; ok: boolean;
	payload?: Record<string, unknown>; error?: string; warnings: string[];
}

/** Map code-point offsets (Rust chars) to UTF-16 offsets (JS strings). */
function cpToUtf16(text: string): (cp: number) => number {
	const idx: number[] = [];
	let u = 0;
	for (const ch of text) { idx.push(u); u += ch.length; }
	idx.push(u);
	return (cp) => idx[Math.min(cp, idx.length - 1)];
}

export class GhostpostUnicodeDecoder implements SignalDecoder {
	readonly codec = CODEC_ID;
	constructor() { initGhostpostCodec(); }

	detect(input: SignalInput): DetectedSignal[] {
		if (!input.text.includes('﻿')) return [];
		if (input.text.length > MAX_INPUT_CHARS) {
			return [{ codec: CODEC_ID, kind: 'oversized_input', ok: false, error: `Input exceeds ${MAX_INPUT_CHARS} chars; not decoded`, confidence: 1 }];
		}
		const envelopes = JSON.parse(wasm.inspect(input.text)) as RawEnvelope[];
		const map = cpToUtf16(input.text);
		return envelopes.map((e) => ({
			codec: CODEC_ID,
			kind: e.ok ? String(e.payload!.kind) : 'corrupt_envelope',
			ok: e.ok,
			payload: e.ok ? e.payload : undefined,
			error: e.ok ? undefined : e.error,
			span: [map(e.start), map(e.end) + 1] as [number, number],
			warnings: e.warnings,
			confidence: 1
		}));
	}
}

/** Encoding side of the provider. Rejects inputs the v1 format would silently truncate. */
export const ghostpostEncoder = {
	codec: CODEC_ID,
	encodeText(carrier: string, secret: string): string {
		initGhostpostCodec();
		return wasm.encode(carrier, secret);
	},
	encodeReference(carrier: string, refType: 'ghostpost' | 'external_url' | 'supabase' | 'crosslink', refId: string, metadata = ''): string {
		initGhostpostCodec();
		const t = { ghostpost: 0, external_url: 1, supabase: 2, crosslink: 3 }[refType];
		for (const [name, v] of [['refId', refId], ['metadata', metadata]] as const) {
			if (Buffer.byteLength(v) > U16_MAX) throw new Error(`${name} exceeds 65535 bytes (v1 length field would truncate silently)`);
		}
		return wasm.encode_reference(carrier, t, refId, metadata);
	}
};
