// 鉴权测试：npm test
// 起一个真的 server.js 子进程（Supabase/cron/出网都换成桩，见 helpers/stub.js），在临时目录里跑，不读仓库的 .env
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASSCODE = 'test-passcode';
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer ${PASSCODE}`, 'Content-Type': 'application/json' };
const JSON_ONLY = { 'Content-Type': 'application/json' };
let server, cwd;

before(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-backend-test-'));
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stub.js'), path.join(__dirname, '..', 'server.js')], {
    cwd,
    env: { PATH: process.env.PATH, PORT: String(PORT), APP_PASSCODE: PASSCODE, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_KEY: 'stub' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => { if (String(d).includes('Server running')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});
after(() => { server?.kill(); fs.rmSync(cwd, { recursive: true, force: true }); });

const call = (method, p, { headers = {}, body } = {}) =>
  fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

// 每条路由：不带口令、口令错都必须 401
const PROTECTED = [
  ['GET', '/api/todos'], ['POST', '/api/todos', { text: 'x' }], ['PUT', '/api/todos/1', { done: true }], ['DELETE', '/api/todos/1'],
  ['GET', '/api/periods'], ['POST', '/api/periods', { date: '2026-10-01' }],
  ['GET', '/api/events?from=2026-10-01&to=2026-10-31'], ['POST', '/api/events', {}], ['PUT', '/api/events/1', {}], ['DELETE', '/api/events/1'], ['POST', '/api/events/sync', {}],
  ['GET', '/api/letters'], ['POST', '/api/letters', {}], ['POST', '/api/letters/1/read'],
];
for (const [method, p, body] of PROTECTED) {
  test(`${method} ${p.split('?')[0]} 不带口令 → 401`, async () => {
    const r = await call(method, p, { headers: JSON_ONLY, body });
    assert.equal(r.status, 401);
  });
  test(`${method} ${p.split('?')[0]} 口令错 → 401`, async () => {
    const r = await call(method, p, { headers: { ...JSON_ONLY, Authorization: 'Bearer wrong' }, body });
    assert.equal(r.status, 401);
  });
}

test('todos 带口令：增、查、改、删都正常', async () => {
  const created = await (await call('POST', '/api/todos', { headers: AUTH, body: { side: 'her', text: '买牛奶', due_time: '2026-10-09' } })).json();
  assert.equal(created.text, '买牛奶');
  const list = await (await call('GET', '/api/todos', { headers: AUTH })).json();
  assert.ok(list.some((t) => t.id === created.id));
  const put = await call('PUT', `/api/todos/${created.id}`, { headers: AUTH, body: { done: true } });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).done, true);
  assert.equal((await call('DELETE', `/api/todos/${created.id}`, { headers: AUTH })).status, 200);
  const after = await (await call('GET', '/api/todos', { headers: AUTH })).json();
  assert.ok(!after.some((t) => t.id === created.id));
});

test('todos 带口令但缺 text → 400（先过鉴权再校验）', async () => {
  assert.equal((await call('POST', '/api/todos', { headers: AUTH, body: {} })).status, 400);
});

test('periods 带口令：同一天点一次记上、再点一次取消', async () => {
  const add = await (await call('POST', '/api/periods', { headers: AUTH, body: { date: '2026-10-02' } })).json();
  assert.equal(add.action, 'added');
  const list = await (await call('GET', '/api/periods', { headers: AUTH })).json();
  assert.ok(list.some((p) => p.date === '2026-10-02'));
  const remove = await (await call('POST', '/api/periods', { headers: AUTH, body: { date: '2026-10-02' } })).json();
  assert.equal(remove.action, 'removed');
});

test('不需要口令的 /health 仍然可以访问', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
});
