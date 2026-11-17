/** Shared by the dataset e2e tests: a real FeltKit dev server with isolated state, and the extension build. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const root = new URL('../../', import.meta.url).pathname;
const freePort = () => new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

export async function startSignal(t: { after: (f: () => unknown) => void }) {
	const port = await freePort();
	const state = mkdtempSync(join(tmpdir(), 'signal-e2e-state-'));
	const proc = spawn(join(root, 'node_modules/.bin/feltkit'), ['dev', '--port', String(port)], { cwd: root, detached: true, env: { ...process.env, FELTKIT_STATE_DIR: state, SIGNAL_ALLOW_PRIVATE_HOSTS: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	await new Promise<void>((ok, fail) => {
		const timer = setTimeout(() => fail(new Error(`feltkit dev did not start:\n${log}`)), 60_000);
		const on = (d: Buffer) => { log += d; if (/Ready in/.test(log)) { clearTimeout(timer); ok(); } };
		proc.stdout.on('data', on); proc.stderr.on('data', on);
		proc.on('exit', (c) => { clearTimeout(timer); fail(new Error(`feltkit dev exited ${c}:\n${log}`)); });
		proc.unref();
	});
	t.after(() => { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ } rmSync(state, { recursive: true, force: true }); });
	return `http://127.0.0.1:${port}`;
}
export const build = () => new Promise<void>((ok, fail) => spawn('node', ['scripts/build-extension.ts'], { cwd: root, stdio: 'inherit' }).on('exit', (c) => (c === 0 ? ok() : fail(new Error('build failed')))));

