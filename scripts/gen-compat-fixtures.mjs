// Generates test/fixtures/ghostpost-369220a.json from the ORIGINAL Ghostpost WASM
// (rkendel1/ghostpost wasm/pkg at commit 369220a). Usage:
//   node scripts/gen-compat-fixtures.mjs /path/to/ghostpost
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const gp = process.argv[2]; if (!gp) throw new Error('pass path to a ghostpost checkout');
const tmp = fs.mkdtempSync('/tmp/gpwasm-'); fs.copyFileSync(path.join(gp, 'wasm/pkg/wasm.js'), path.join(tmp, 'wasm.mjs'));
const m = await import(pathToFileURL(path.join(tmp, 'wasm.mjs')));
m.initSync({ module: fs.readFileSync(path.join(gp, 'wasm/pkg/wasm_bg.wasm')) });
const cases = [];
const text = [['hello', 'bye'], ['Unicode carrier ✓ 🙂', 'Secret émoji 🙂 中文'], ['', 'empty carrier'], ['big', 'x'.repeat(1500) + 'END'],
  ['img', 'data:image/jpeg;base64,' + Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251)).toString('base64')],
  ['tracked', 'msg||ghostid:2b1f0c1e-1111-4222-8333-444455556666||']];
for (const [c, s] of text) cases.push({ kind: 'text', carrier: c, secret: s, encoded: m.encode(c, s) });
for (const [t, id, meta] of [[0, 'abc123', ''], [1, 'https://example.com/x?y=1', '{"k":1}'], [2, 'bucket/path.png', '']])
  cases.push({ kind: 'reference', refType: t, refId: id, metadata: meta, encoded: m.encode_reference('ref carrier', t, id, meta) });
cases.push({ kind: 'secure_note', noteId: 'note-1', password: 'pw', metadata: '', encoded: m.encode_secure_note('note carrier', 'note-1', 'pw', '') });
cases.push({ kind: 'ai_prompt', aiType: 1, prompt: 'write a poem', encoded: m.encode_ai_prompt('ai carrier', 1, 'write a poem', '', '') });
fs.writeFileSync(new URL('../test/fixtures/ghostpost-369220a.json', import.meta.url), JSON.stringify({ source: 'rkendel1/ghostpost@369220a wasm/pkg', cases }, null, 1));
console.log('wrote', cases.length, 'cases');
