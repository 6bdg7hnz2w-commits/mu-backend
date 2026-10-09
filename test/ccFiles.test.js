// 沐 (CC) 发文件：npm test
// 起一个假 bridge（只记下收到了什么）+ 真的 server.js 子进程，看后端怎么校验、怎么转发
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
const TYPES = {
  max_bytes: 20 * 1024 * 1024,
  max_items: 9,
  types: [
    { ext: 'pdf', kind: 'pdf', mime: ['application/pdf'] },
    { ext: 'txt', kind: 'text', mime: ['text/plain'] },
    { ext: 'csv', kind: 'text', mime: ['text/csv', 'application/vnd.ms-excel'] },
    { ext: 'py', kind: 'text', mime: ['application/x-python'] },
  ],
};
let server, bridge, bridgeUrl, cwd;
const seen = []; // 假 bridge 收到的请求

before(async () => {
  bridge = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url === '/file-types') return send(200, TYPES);
      if (req.url === '/upload') {
        const name = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : null;
        return send(200, name ? { id: 'f1', path: '/var/lib/mu-bridge/uploads/2026-10-09/f1-x.pdf', name, size: body.length, mime: 'application/pdf' } : { id: 'i1', path: '/var/lib/mu-bridge/uploads/2026-10-09/i1.jpg' });
      }
      if (req.url === '/send') return send(200, { ok: true, id: 'm1', time: '2026-10-09T10:00:00+08:00' });
      if (req.url.startsWith('/uploads/')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename=\"__.pdf\"; filename*=UTF-8''%E5%91%A8%E6%8A%A5.pdf" });
        return res.end('%PDF-1.4');
      }
      send(404, { error: 'not found' });
    });
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

const lastTo = (url) => [...seen].reverse().find((r) => r.url === url);
function form(field, content, filename, type, name) {
  const f = new FormData();
  if (name !== undefined) f.append('name', name);
  f.append(field, new Blob([content], { type }), filename);
  return f;
}
const upload = (f) => fetch(`${BASE}/api/cc/upload`, { method: 'POST', headers: AUTH, body: f });

test('白名单接口：带口令拿到 bridge 的白名单', async () => {
  const r = await fetch(`${BASE}/api/cc/file-types`, { headers: AUTH });
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.equal(t.max_items, 9);
  assert.deepEqual(t.types.map((x) => x.ext), ['pdf', 'txt', 'csv', 'py']);
});

test('图片照旧：字段 image，转给 bridge 时不带 X-File-Name，只回 id + path', async () => {
  const r = await upload(form('image', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image.jpg', 'image/jpeg'));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'i1', path: '/var/lib/mu-bridge/uploads/2026-10-09/i1.jpg' });
  const req = lastTo('/upload');
  assert.equal(req.headers['content-type'], 'image/jpeg');
  assert.equal(req.headers['x-file-name'], undefined);
});

test('图片字段传非图片 → 400', async () => {
  const r = await upload(form('image', 'hello', 'a.txt', 'text/plain'));
  assert.equal(r.status, 400);
});

test('白名单里的 pdf：中文原名经 name 字段带过去，bridge 收到 X-File-Name', async () => {
  const before = seen.length;
  const r = await upload(form('file', '%PDF-1.4 x', 'x.pdf', 'application/pdf', '周报 终版.pdf'));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.name, '周报 终版.pdf');
  assert.ok(seen.length > before);
  assert.equal(decodeURIComponent(lastTo('/upload').headers['x-file-name']), '周报 终版.pdf');
});

test('没有 name 字段时用 multipart 的文件名（UTF-8）', async () => {
  const r = await upload(form('file', 'a,b\n1,2\n', '数据.csv', 'text/csv'));
  assert.equal(r.status, 200);
  assert.equal(decodeURIComponent(lastTo('/upload').headers['x-file-name']), '数据.csv');
});

test('代码文件：浏览器报空类型也收', async () => {
  const r = await upload(form('file', 'print(1)\n', 'a.py', ''));
  assert.equal(r.status, 200);
});

for (const [label, args] of [
  ['白名单外的 docx', ['PK\x03\x04', 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['没扩展名', ['hello', 'README', 'text/plain']],
  ['扩展名对、类型不对（txt 报成 image/png）', ['hello', 'a.txt', 'image/png']],
  ['扩展名是 pdf、内容不是', ['hello', 'a.pdf', 'application/pdf']],
  ['扩展名是 txt、内容是二进制', [Buffer.from([0x50, 0x4b, 0x00, 0x01]), 'a.txt', 'text/plain']],
]) {
  test(`绕过前端直接打后端：${label} → 415，不转给 bridge`, async () => {
    const before = seen.filter((r) => r.url === '/upload').length;
    const r = await upload(form('file', ...args));
    assert.equal(r.status, 415);
    assert.ok((await r.json()).error);
    assert.equal(seen.filter((r) => r.url === '/upload').length, before);
  });
}

test('21MB 文件 → 413，提示 20MB', async () => {
  const r = await upload(form('file', Buffer.alloc(21 * 1024 * 1024, 0x61), 'big.txt', 'text/plain'));
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /20MB/);
});

test('send：图片 + 文件合计 9 个 → 转给 bridge', async () => {
  const body = { text: '看看', images: Array(4).fill('/u/i.jpg'), files: Array(5).fill('/u/f.pdf') };
  const r = await fetch(`${BASE}/api/cc/send`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(lastTo('/send').body), body);
});

test('send：只有图片时发给 bridge 的内容和以前一样（没有 files 字段）', async () => {
  const r = await fetch(`${BASE}/api/cc/send`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi', images: ['/u/i.jpg'] }) });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(lastTo('/send').body), { text: 'hi', images: ['/u/i.jpg'] });
});

test('send：合计 10 个 → 400', async () => {
  const body = { images: Array(5).fill('/u/i.jpg'), files: Array(5).fill('/u/f.pdf') };
  const r = await fetch(`${BASE}/api/cc/send`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /9/);
});

test('send：只有文件、没有文字也能发', async () => {
  const r = await fetch(`${BASE}/api/cc/send`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ files: ['/u/f.pdf'] }) });
  assert.equal(r.status, 200);
});

test('uploads 回显：带回类型和原文件名', async () => {
  const r = await fetch(`${BASE}/api/cc/uploads/2026-10-09/f1-x.pdf`, { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''%E5%91%A8%E6%8A%A5\.pdf/);
});
