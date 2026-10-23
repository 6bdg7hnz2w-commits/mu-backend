// 沐的记忆和相册（App 的 Memory / Album 页，只读）：npm test
// 假 bridge + 真的 server.js 子进程，看口令、转发路径、bridge 的 token、图片原样流回
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASSCODE = 'test-passcode';
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer ${PASSCODE}` };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
let server, bridge, bridgeUrl, cwd;
const seen = [];

before(async () => {
  bridge = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/memory') return send(200, { files: [{ name: 'our-story.md', title: '我们', description: '', size: 20, mtime: '2026-10-19T07:15:00.000Z', body: '# 我们' }] });
    if (req.url === '/album') return send(200, { photos: [{ file: '2026-10-15-f8a11b16d96c.jpg', at: '2026-10-15 18:32', desc: '小白房子' }] });
    if (req.url.startsWith('/album/2026-10-15-f8a11b16d96c.jpg')) {
      res.writeHead(200, { 'Content-Type': req.url.includes('thumb=1') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Length': JPG.length });
      return res.end(JPG);
    }
    send(404, { error: 'not found' });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-backend-test-'));
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stub.js'), path.join(__dirname, '..', 'server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH, PORT: String(PORT), APP_PASSCODE: PASSCODE, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_KEY: 'stub',
      BRIDGE_URL: bridgeUrl, BRIDGE_TOKEN: 'bridge-test-token', STUB_ALLOW_FETCH: bridgeUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => { if (String(d).includes('Server running')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});
after(() => { server?.kill(); bridge?.close(); fs.rmSync(cwd, { recursive: true, force: true }); });

test('没口令拿不到记忆和相册', async () => {
  for (const p of ['/api/cc/memory', '/api/cc/album', '/api/cc/album/2026-10-15-f8a11b16d96c.jpg']) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
  }
});

test('记忆和相册列表原样转 bridge，带 bridge token', async () => {
  const m = await fetch(`${BASE}/api/cc/memory`, { headers: AUTH });
  assert.equal(m.status, 200);
  assert.equal((await m.json()).files[0].title, '我们');
  const a = await fetch(`${BASE}/api/cc/album`, { headers: AUTH });
  assert.equal((await a.json()).photos[0].desc, '小白房子');
  assert.equal(seen.find((r) => r.url === '/memory').auth, 'Bearer bridge-test-token');
});

test('相册图片：原图和缩略图都原样流回，404 照传', async () => {
  const r = await fetch(`${BASE}/api/cc/album/2026-10-15-f8a11b16d96c.jpg`, { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPG);
  const t = await fetch(`${BASE}/api/cc/album/2026-10-15-f8a11b16d96c.jpg?thumb=1`, { headers: AUTH });
  assert.equal(t.headers.get('content-type'), 'image/webp');
  assert.equal((await fetch(`${BASE}/api/cc/album/nope.jpg`, { headers: AUTH })).status, 404);
});
