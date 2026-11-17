import type { DetectedSignal, SignalDecoder, SignalInput } from '../contracts/types.ts';

/**
 * Codec `invisible-unicode/v1`: format-agnostic detection of clustered invisible
 * characters (zero-width, bidi controls, tag characters). Generalised from
 * ghostpost packages/overlay-runtime/pattern-detector/detector.ts, which only
 * recognised the 9 Ghostpost characters and reported one result per text.
 *
 * This reports *that* something is embedded and where, not what it means —
 * format-specific decoders (e.g. ghostpost-unicode/v1) interpret it.
 * Legitimate isolated use (ZWJ inside emoji, single LRM/RLM in RTL text) is not reported.
 */
export const CODEC_ID = 'invisible-unicode/v1';

// Zero-width + bidi controls + word joiner family + BOM + Unicode tag block.
const INVISIBLE_SRC = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/.source;
const MIN_RUN = 8; // shorter runs are formatting noise
const MAX_GAP = 1; // allow at most one visible char inside a run

export class InvisibleUnicodeDetector implements SignalDecoder {
	readonly codec = CODEC_ID;

	detect(input: SignalInput): DetectedSignal[] {
		const text = input.text;
		const out: DetectedSignal[] = [];
		let runStart = -1, runEnd = -1, count = 0;
		const flush = () => {
			if (count >= MIN_RUN) {
				const hist: Record<string, number> = {};
				for (const ch of text.slice(runStart, runEnd).match(new RegExp(INVISIBLE_SRC, 'g')) ?? []) {
					const k = 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
					hist[k] = (hist[k] ?? 0) + 1;
				}
				out.push({
					codec: CODEC_ID, kind: 'invisible_cluster', ok: true, confidence: 1,
					span: [runStart, runEnd],
					payload: { count, distinct: Object.keys(hist).length, codepoints: hist }
				});
			}
			runStart = -1; count = 0;
		};
		const re = new RegExp(INVISIBLE_SRC, 'g'); // local instance: no shared lastIndex
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			if (runStart >= 0 && m.index - runEnd > MAX_GAP) flush();
			if (runStart < 0) runStart = m.index;
			runEnd = m.index + m[0].length;
			count++;
		}
		if (runStart >= 0) flush();
		return out;
	}
}
