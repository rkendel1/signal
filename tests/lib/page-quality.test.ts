/**
 * Regression floor for real-page quality: every retained real page is scored against its independent
 * label and must not fall below the measurement committed in docs/page-quality.json. This guards
 * against regressions; it is not evidence of accuracy beyond these pages (see PAGE_QUALITY.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { scorePage, summarize, type Label } from '../eval/score.ts';

const dir = new URL('../fixtures/real/', import.meta.url);
const measured = new Map((JSON.parse(readFileSync(new URL('../../docs/page-quality.json', import.meta.url), 'utf8')).pages as Array<Record<string, any>>).map((p) => [p.id, p]));
const METRICS = ['entityRecall', 'entityPrecision', 'attributeRecall', 'attributePrecision', 'relationshipRecall', 'relationshipPrecision', 'traceability'] as const;

for (const f of readdirSync(new URL('labels/', dir)).filter((x) => x.endsWith('.json')).sort()) {
	const label = JSON.parse(readFileSync(new URL(`labels/${f}`, dir), 'utf8')) as Label;
	test(`real page ${label.id} (${label.category}) does not regress`, () => {
		const prov = JSON.parse(readFileSync(new URL(`${label.id}.provenance.json`, dir), 'utf8'));
		const html = readFileSync(new URL(`${label.id}.html`, dir), 'utf8');
		const rep = extractPage({ html, locator: prov.url, baseUrl: prov.finalUrl ?? prov.url, observationId: `eval_${label.id}`, contentHash: prov.sha256, contentType: prov.contentType, observedAt: prov.fetchedAt });
		const s = summarize(scorePage(label, rep, html)) as Record<string, any>;
		const base = measured.get(label.id);
		assert.ok(base, `no committed measurement for ${label.id}`);
		for (const m of METRICS) {
			if (base[m] === null) continue;
			assert.ok(s[m] !== null && s[m] >= base[m] - 1e-9, `${m}: ${s[m]} < measured ${base[m]}`);
		}
		assert.ok(s.duplicateRate <= base.duplicateRate + 1e-9, `duplicateRate ${s.duplicateRate} > ${base.duplicateRate}`);
	});
}
