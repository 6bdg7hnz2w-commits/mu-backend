// 日记封存：npm test
// 和 auth.test.js 一样起一个真的 server.js 子进程（Supabase/出网都换成桩），多给一把 BRIDGE_TOKEN 当沐
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASSCODE = 'test-passcode';
const BRIDGE_TOKEN = 'test-bridge-token';
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const HER = { Authorization: `Bearer ${PASSCODE}`, 'Content-Type': 'application/json' };
const MU = { Authorization: `Bearer ${BRIDGE_TOKEN}`, 'Content-Type': 'application/json' };
let server, cwd;

before(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-backend-test-'));
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stub.js'), path.join(__dirname, '..', 'server.js')], {
    cwd,
    env: { PATH: process.env.PATH, PORT: String(PORT), APP_PASSCODE: PASSCODE, BRIDGE_TOKEN, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_KEY: 'stub' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => { if (String(d).includes('Server running')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});
after(() => { server?.kill(); fs.rmSync(cwd, { recursive: true, force: true }); });

const call = async (method, p, headers, body) => {
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const PUBLIC_KEYS = ['author', 'content', 'created_at', 'diary_date', 'id', 'revealed_at', 'visibility'];
const list = async () => (await call('GET', '/api/diaries', HER)).body;

test('沐写一篇封存的：列表里正文是 null，只有约定的那几个字段', async () => {
  const w = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-20', content: '不想让她现在看到', visibility: 'hidden' });
  assert.equal(w.status, 200);
  assert.equal(w.body.visibility, 'hidden');
  assert.equal(w.body.content, null);
  const d = (await list()).find((x) => x.id === w.body.id);
  assert.deepEqual(Object.keys(d).sort(), PUBLIC_KEYS);
  assert.equal(typeof d.id, 'string');
  assert.equal(d.visibility, 'hidden');
  assert.equal(d.content, null);
  assert.equal(d.revealed_at, null);
  assert.equal(d.diary_date, '2026-10-20');
});

test('visibility 不对 → 400', async () => {
  assert.equal((await call('PUT', '/api/mu/diary', HER, { date: '2026-10-21', content: 'x', visibility: 'secret' })).status, 400);
});

test('不给 visibility 当 public（旧的 deliver.py）', async () => {
  const w = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-21', content: '今天很好' });
  assert.equal(w.body.visibility, 'public');
  assert.equal(w.body.content, '今天很好');
});

test('同一天重写不能把公开的改回封存；封存的重写成公开算拆封', async () => {
  const again = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-21', content: '改一下', visibility: 'hidden' });
  assert.equal(again.body.visibility, 'public');
  assert.equal(again.body.content, '改一下');
  const sealed = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-19', content: '先封着', visibility: 'hidden' });
  const opened = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-19', content: '还是给她看吧', visibility: 'public' });
  assert.equal(opened.body.id, sealed.body.id);
  assert.equal(opened.body.visibility, 'public');
  assert.ok(opened.body.revealed_at);
});

test('按日期拆封：hidden → public，带 revealed_at；再拆一次不变；前端口令进不来', async () => {
  const w = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-17', content: '现在可以给你看了', visibility: 'hidden' });
  assert.equal((await call('POST', '/api/mu/diary/reveal', HER, { date: '2026-10-17' })).status, 401);
  assert.equal((await list()).find((x) => x.id === w.body.id).visibility, 'hidden');
  const r = await call('POST', '/api/mu/diary/reveal', MU, { date: '2026-10-17' });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, w.body.id);
  assert.equal(r.body.visibility, 'public');
  assert.equal(r.body.content, '现在可以给你看了');
  assert.ok(r.body.revealed_at);
  const again = await call('POST', '/api/mu/diary/reveal', MU, { date: '2026-10-17' });
  assert.equal(again.body.revealed_at, r.body.revealed_at);
  const d = (await list()).find((x) => x.id === w.body.id);
  assert.equal(d.content, '现在可以给你看了');
  assert.equal(d.revealed_at, r.body.revealed_at);
  assert.equal((await call('POST', '/api/mu/diary/reveal', MU, { date: '2001-01-01' })).status, 404);
  assert.equal((await call('POST', '/api/mu/diary/reveal', MU, { date: 'yesterday' })).status, 400);
});

test('桦桦写的永远公开；前端不能冒充沐写，也不能改沐的', async () => {
  const her = await call('POST', '/api/diaries', HER, { author: 'her', content: '我的日记' });
  assert.equal(her.body.visibility, 'public');
  assert.equal(her.body.revealed_at, null);
  assert.deepEqual(Object.keys(her.body).sort(), PUBLIC_KEYS);
  assert.equal((await call('POST', '/api/diaries', HER, { author: 'mu', content: '冒充' })).status, 400);
  const edited = await call('PUT', `/api/diaries/${her.body.id}`, HER, { content: '改过的' });
  assert.equal(edited.body.content, '改过的');
  const mu = await call('PUT', '/api/mu/diary', HER, { date: '2026-10-16', content: '封存', visibility: 'hidden' });
  assert.equal((await call('PUT', `/api/diaries/${mu.body.id}`, HER, { content: '偷看' })).status, 404);
  assert.equal((await list()).find((x) => x.id === mu.body.id).content, null);
});
