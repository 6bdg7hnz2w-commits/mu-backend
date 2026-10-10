// 沐 (CC) 聊天三件小功能：npm test
// 断线提示（history?system=1、/api/cc/retry）、发送失败重发（client_id 透传）、消息更正（/api/cc/edit）
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
const AUTH = { Authorization: `Bearer ${PASSCODE}`, 'Content-Type': 'application/json' };
let server, bridge, bridgeUrl, cwd;
const seen = []; // 假 bridge 收到的请求

before(async () => {
  bridge = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/file-types') return send(200, { max_bytes: 1024, max_items: 9, types: [] });
      if (req.url === '/send') return send(200, { ok: true, id: 'm1', time: '2026-10-10T10:00:00+08:00' });
      if (req.url.startsWith('/history')) return send(200, { messages: [], has_more: false });
      if (req.url === '/edit') {
        if (body.id === 'missing') return send(404, { error: '找不到这条消息' });
        return send(200, { ok: true, message: { id: body.id, role: 'user', text: body.text, time: '2026-10-10T10:00:00+08:00', edited_at: '2026-10-10T10:05:00+08:00' }, notified: true });
      }
      if (req.url === '/retry') return body.id === 'done' ? send(409, { error: '他已经回过了，不用再叫' }) : send(200, { ok: true });
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
const countTo = (url) => seen.filter((r) => r.url === url).length;
const post = (p, body, headers = AUTH) => fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) });

// --- 发送失败重发：client_id ---
test('send：client_id 原样带给 bridge（带 BRIDGE_TOKEN）', async () => {
  assert.equal((await post('/api/cc/send', { text: 'hi', client_id: 'c-123_abc' })).status, 200);
  const got = lastTo('/send');
  assert.equal(got.body.client_id, 'c-123_abc');
  assert.equal(got.headers.authorization, 'Bearer bridge-test-token');
});

test('send：不带 client_id 时发给 bridge 的内容和以前一样', async () => {
  assert.equal((await post('/api/cc/send', { text: 'hi' })).status, 200);
  assert.deepEqual(lastTo('/send').body, { text: 'hi' });
});

for (const bad of [123, '', 'has space', 'x'.repeat(65), '../etc', { a: 1 }]) {
  test(`send：client_id=${JSON.stringify(bad).slice(0, 20)} → 400，不转给 bridge`, async () => {
    const n = countTo('/send');
    assert.equal((await post('/api/cc/send', { text: 'hi', client_id: bad })).status, 400);
    assert.equal(countTo('/send'), n);
  });
}

// --- 消息更正 ---
test('edit：转给 bridge（去掉首尾空格），回更新后的消息', async () => {
  const r = await post('/api/cc/edit', { id: 'abc-1', text: '  改好了  ' });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.message.text, '改好了');
  assert.ok(data.message.edited_at);
  assert.deepEqual(lastTo('/edit').body, { id: 'abc-1', text: '改好了' });
  assert.equal(lastTo('/edit').headers.authorization, 'Bearer bridge-test-token');
});

for (const [name, body] of [
  ['缺 id', { text: 'x' }],
  ['id 不是字符串', { id: 1, text: 'x' }],
  ['id 带奇怪字符', { id: 'a/b', text: 'x' }],
  ['缺 text', { id: 'abc' }],
  ['text 不是字符串', { id: 'abc', text: 1 }],
  ['改成空的', { id: 'abc', text: '   ' }],
  ['太长', { id: 'abc', text: 'x'.repeat(20001) }],
]) {
  test(`edit：${name} → 400，不转给 bridge`, async () => {
    const n = countTo('/edit');
    assert.equal((await post('/api/cc/edit', body)).status, 400);
    assert.equal(countTo('/edit'), n);
  });
}

test('edit：bridge 说找不到 → 404 原样回给前端', async () => {
  const r = await post('/api/cc/edit', { id: 'missing', text: 'x' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, '找不到这条消息');
});

// --- 断线提示 ---
test('retry：转给 bridge，只带 id', async () => {
  assert.equal((await post('/api/cc/retry', { id: 'abc-2', extra: 'x' })).status, 200);
  assert.deepEqual(lastTo('/retry').body, { id: 'abc-2' });
});

test('retry：缺 id 或 id 不对 → 400', async () => {
  assert.equal((await post('/api/cc/retry', {})).status, 400);
  assert.equal((await post('/api/cc/retry', { id: 'a b' })).status, 400);
});

test('retry：bridge 说已经回过了 → 409 原样回给前端', async () => {
  assert.equal((await post('/api/cc/retry', { id: 'done' })).status, 409);
});

test('history：system=1 透传给 bridge，别的值不透传', async () => {
  const lastHistory = () => [...seen].reverse().find((r) => r.url.startsWith('/history')).url;
  await fetch(`${BASE}/api/cc/history?limit=30&system=1`, { headers: AUTH });
  assert.match(lastHistory(), /[?&]system=1(&|$)/);
  await fetch(`${BASE}/api/cc/history?limit=30&system=yes`, { headers: AUTH });
  assert.doesNotMatch(lastHistory(), /system/);
});

test('新路由不带口令 → 401，不会转给 bridge', async () => {
  const n = seen.length;
  for (const p of ['/api/cc/edit', '/api/cc/retry']) {
    assert.equal((await post(p, { id: 'abc', text: 'x' }, { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.7.7' })).status, 401);
  }
  assert.equal(seen.length, n);
});
