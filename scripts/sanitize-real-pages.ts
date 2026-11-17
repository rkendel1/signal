/**
 * Deterministic sanitization of retained real pages (run after fetch-real-pages.ts).
 * Uses plain string/regex rewriting — never the extractor under evaluation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('../tests/fixtures/real/', import.meta.url);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function apply(id: string, rewrite: (html: string) => { html: string; notes: string[] }) {
	const file = new URL(`${id}.html`, dir);
	const prov = JSON.parse(readFileSync(new URL(`${id}.provenance.json`, dir), 'utf8'));
	if (prov.sanitized && !process.argv.includes('--force')) { console.log('already sanitized', id); return; }
	const { html, notes } = rewrite(readFileSync(file, 'utf8'));
	writeFileSync(file, html);
	writeFileSync(new URL(`${id}.provenance.json`, dir), JSON.stringify({ ...prov, sanitized: true, sanitization: notes, originalSha256: prov.originalSha256 ?? prov.sha256, sha256: sha(html) }, null, 2) + '\n');
	console.log('sanitized', id, notes.length);
}

if (!process.argv.includes('--force')) apply('arxiv-abs', (html) => {
	const notes = ['abstract text replaced (arXiv non-exclusive license); title, authors, dates and identifiers kept as bibliographic facts'];
	html = html.replace(/(<blockquote class="abstract[^"]*">)[\s\S]*?(<\/blockquote>)/, '$1<span class="descriptor">Abstract:</span>[abstract removed for retention]$2');
	html = html.replace(/(<meta (?:name|property)="(?:citation_abstract|og:description|twitter:description|description)" content=")[^"]*(")/g, '$1[abstract removed for retention]$2');
	return { html, notes };
});

apply('hn-item', (html) => {
	const users = new Map<string, string>();
	const alias = (u: string) => { if (!users.has(u)) users.set(u, `user${users.size + 1}`); return users.get(u)!; };
	html = html.replace(/<a href="user\?id=([^"]+)"([^>]*)>([^<]+)<\/a>/g, (_m, id, attrs) => `<a href="user?id=${alias(id)}"${attrs}>${alias(id)}</a>`);
	html = html.replace(/(href="threads\?id=)([^"]+)/g, (_m, a, id) => `${a}${alias(id)}`);
	let n = 0;
	html = html.replace(/(<div class="commtext c00">)([\s\S]*?)(<\/div>)/g, (_m, a, _t, c) => `${a}[comment ${++n} text removed for retention]${c}`);
	html = html.replace(/(href="(?:from|threads|favorite|hide|vote|flag)[^"]*?)(?:auth|goto)=[^"&]*/g, '$1');
	return { html, notes: [`${users.size} usernames replaced with userN aliases`, `${n} comment bodies replaced`, 'per-session auth/goto query values removed'] };
});
