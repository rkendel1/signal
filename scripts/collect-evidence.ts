/**
 * Run the site collector in a real browser page and print the evidence as JSON (what the extension does when a
 * person presses "Understand this site", without the extension). For real-site validation and fixtures.
 *
 *   node scripts/collect-evidence.ts <url> [--out file] [--snapshot]
 *
 * Uses the environment's HTTPS proxy when set. Public pages only: it signs in to nothing.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { collectSiteEvidence } from '../lib/site/collect.ts';

export async function collect(url: string, opts: { snapshot?: boolean; settleMs?: number; then?: (page: any) => Promise<void> } = {}) {
	const { chromium } = createRequire(import.meta.url)('playwright');
	const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
	try {
		const page = await browser.newPage();
		const t0 = performance.now();
		await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
		await page.waitForTimeout(opts.settleMs ?? 1500);
		if (opts.then) await opts.then(page);
		const loadMs = Math.round(performance.now() - t0);
		const snapshot = opts.snapshot ? await page.evaluate(() => { const c = document.documentElement.cloneNode(true) as HTMLElement; c.querySelectorAll('script:not([type="application/ld+json"]),style,svg,noscript,iframe').forEach((e) => e.remove()); return '<!doctype html>' + c.outerHTML; }) : null;
		const t1 = performance.now();
		const evidence = await page.evaluate(collectSiteEvidence, { maxFetches: 8, snapshot: snapshot && snapshot.length < 900_000 ? snapshot : null, collector: 'signal-collector/1 (playwright)' });
		return { evidence, loadMs, collectMs: Math.round(performance.now() - t1) };
	} finally { await browser.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const url = process.argv[2];
	const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
	const r = await collect(url, { snapshot: process.argv.includes('--snapshot') });
	const text = JSON.stringify(r.evidence);
	if (out) writeFileSync(out, text); else console.log(text);
	console.error(`loaded in ${r.loadMs} ms, collected in ${r.collectMs} ms, ${text.length} bytes`);
}
