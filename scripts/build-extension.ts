/**
 * Builds the loadable extension into extension/dist: `node scripts/build-extension.ts`.
 * Load it in Chrome via chrome://extensions → Developer mode → Load unpacked → extension/dist.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const out = new URL('extension/dist/', root);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL('icons/', out), { recursive: true });
await build({
	entryPoints: { panel: new URL('extension/src/panel.ts', root).pathname, background: new URL('extension/src/background.ts', root).pathname },
	outdir: out.pathname, bundle: true, format: 'esm', platform: 'browser', target: 'chrome116', minify: false, sourcemap: false, logLevel: 'warning', legalComments: 'none'
});
const copy = (from: string, to: string) => copyFileSync(new URL(from, root), new URL(to, out));
copy('extension/manifest.json', 'manifest.json');
copy('extension/panel.html', 'panel.html');
copy('extension/panel.css', 'panel.css');
for (const n of [16, 48, 128]) copy(`extension/icons/icon${n}.png`, `icons/icon${n}.png`);
console.log('extension built:', out.pathname);
