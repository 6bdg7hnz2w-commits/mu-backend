// 沐 (CC) 并线 API：npm test
// 一个假服务同时当 bridge 和中转站（/v1/chat/completions），真的 server.js 子进程；
// 后半部分直接在进程里测 lib/apiTurn.js（人设退回、上文顺序、图片之类）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeApiTurns, orderForModel, splitThinking } = require('../lib/apiTurn');

const PASSCODE = 'test-passcode';
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer ${PASSCODE}`, 'Content-Type': 'application/json' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// --- 假 bridge + 假中转站 ---
function makeFake() {
  const f = {
    seen: [], history: [], seq: 0, brain: { target: 'cc', api_model: null, api_group: null },
    hasBrain: true, persona: '你是沐（bridge 给的人设）。', relayQueue: [], relayCalls: [],
  };
  f.reset = () => {
    f.seen.length = 0; f.history.length = 0; f.relayQueue.length = 0; f.relayCalls.length = 0;
    f.brain = { target: 'cc', api_model: null, api_group: null }; f.hasBrain = true;
  };
  f.addMessage = (m) => { const msg = { time: new Date().toISOString(), seq: ++f.seq, ...m }; f.history.push(msg); return msg; };
  f.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const url = req.url;
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.startsWith('/v1/')) {
        f.relayCalls.push({ url, body, auth: req.headers.authorization });
        if (JSON.stringify(body.messages).includes('记忆压缩助手')) {
          return send(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '压缩后的记忆' } }] });
        }
        const next = f.relayQueue.shift() || { content: '嗯，我在。', reasoning_content: '她回来了，想一想怎么说。' };
        if (next.status) return send(next.status, { error: { message: next.message || 'boom' } });
        if (next.delay) return setTimeout(() => send(200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: next.content } }] }), next.delay);
        return send(200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: next.content, ...(next.reasoning_content ? { reasoning_content: next.reasoning_content } : {}) } }] });
      }
      f.seen.push({ method: req.method, url, headers: req.headers, body });
      if (url === '/brain') {
        if (!f.hasBrain) return send(404, { error: 'not found' });
        if (req.method === 'POST') {
          if (body.target && !['cc', 'api'].includes(body.target)) return send(400, { error: 'bad target' });
          for (const k of ['target', 'api_model', 'api_group']) if (k in body) f.brain[k] = body[k];
        }
        return send(200, f.brain);
      }
      if (url === '/send') {
        const m = f.addMessage({ id: `u${f.seq + 1}`, role: 'user', text: body.text, ...(body.images ? { images: body.images } : {}) });
        return send(200, { ok: true, id: m.id, time: m.time, seq: m.seq, ...(f.hasBrain ? { brain: f.brain.target } : {}) });
      }
      if (url === '/retry') return f.brain.target === 'api' ? send(200, { ok: true, brain: 'api' }) : send(200, { ok: true });
      if (url.startsWith('/history')) return send(200, { messages: f.history.slice(), has_more: false });
      if (url === '/reply') {
        const m = f.addMessage({ id: `a${f.seq + 1}`, role: 'assistant', text: body.text, via: 'api', model: body.model, group: body.group, reply_to: body.reply_to, pid: body.turn_id, ...(body.thinking ? { thinking: body.thinking } : {}) });
        return send(200, { ok: true, id: m.id, seq: m.seq });
      }
      if (url === '/system') return send(200, { ok: true });
      if (url === '/typing') return send(200, { ok: true });
      if (url === '/persona') return f.persona === 'ERR' ? send(500, { error: 'busy' }) : f.persona ? send(200, { text: f.persona }) : send(404, { error: 'no persona' });
      if (url === '/file-types') return send(200, { max_bytes: 1024 * 1024, max_items: 9, types: [{ ext: 'txt', kind: 'text', mime: ['text/plain'] }] });
      if (url.startsWith('/uploads/')) {
        if (url.endsWith('.txt')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('文件里的字'); }
        res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
      }
      send(404, { error: 'not found' });
    });
  });
  return f;
}

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

// --- 起 server.js ---
const fake = makeFake();
let server, fakeUrl, cwd;
before(async () => {
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.server.address().port}`;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-backend-test-'));
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers/stub.js'), path.join(__dirname, '..', 'server.js')], {
    cwd,
    env: {
      PATH: process.env.PATH, PORT: String(PORT), APP_PASSCODE: PASSCODE, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_KEY: 'stub',
      BRIDGE_URL: fakeUrl, BRIDGE_TOKEN: 'bridge-test-token', STUB_ALLOW_FETCH: fakeUrl,
      RELAY_BASE_URL: `${fakeUrl}/v1`, RELAY_API_KEY: 'key-default', RELAY_KEY_CLAUDE_OR: 'key-or', API_TURN_DEBOUNCE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => { if (String(d).includes('Server running')) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});
after(() => { server?.kill(); fake.server.close(); fs.rmSync(cwd, { recursive: true, force: true }); });

const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
const get = (p) => fetch(BASE + p, { headers: AUTH });
const lastTo = (url) => [...fake.seen].reverse().find((r) => r.url === url);
const countTo = (url) => fake.seen.filter((r) => r.url === url).length;
const useApi = (model = '[K]claude-opus-4-6-thinking', group = 'default') => { fake.brain = { target: 'api', api_model: model, api_group: group }; };

// --- 模型目录 ---
test('api-models：按截图列出模型，分组 key 没配的 ready=false', async () => {
  fake.reset();
  const data = await (await get('/api/cc/api-models')).json();
  assert.deepEqual(data.default, { model: '[K]claude-opus-4-6-thinking', group: 'default' });
  assert.deepEqual(data.families.map((f) => f.name), ['Opus 4.5', 'Opus 4.6', 'Opus 4.7', 'Opus 4.8', 'Opus 5.5', 'Fable 5', 'Fable 5.1']);
  const all = data.families.flatMap((f) => f.options);
  const byModel = (m, g = 'default') => all.find((o) => o.model === m && o.group === g);
  assert.equal(byModel('[K]claude-opus-4-6-thinking').label, 'K · thinking');
  assert.equal(byModel('[K]claude-opus-4-6-thinking').thinking, true);
  assert.equal(byModel('[K]claude-opus-4-6').desc, 'kiro，RFv3对RP与人机恋各场景表现调优');
  assert.equal(byModel('[A]claude-hybrid2').label, 'A · hybrid2');
  assert.equal(byModel('[P]claude-opus-5-5-thinking').ready, true);
  assert.equal(byModel('claude-fable-5', 'claude-awsb').ready, false); // RELAY_KEY_CLAUDE_AWSB 没配
  assert.equal(byModel('claude-fable-5-1', 'claude-or').ready, true);
  assert.equal(new Set(all.map((o) => o.id)).size, all.length);
});

// --- 开关 ---
test('brain GET：带上选中模型在目录里的样子', async () => {
  fake.reset();
  useApi('[B]claude-opus-4-7');
  const data = await (await get('/api/cc/brain')).json();
  assert.equal(data.supported, true);
  assert.equal(data.target, 'api');
  assert.equal(data.option.label, 'B');
  assert.deepEqual(data.family, { key: 'opus-4-7', name: 'Opus 4.7' });
  assert.equal(lastTo('/brain').headers.authorization, 'Bearer bridge-test-token');
});

test('brain GET：bridge 没有 /brain → supported=false', async () => {
  fake.reset();
  fake.hasBrain = false;
  assert.deepEqual(await (await get('/api/cc/brain')).json(), { supported: false, target: 'cc', model: null, group: null, option: null, family: null });
});

test('brain POST：选模型 → 转给 bridge', async () => {
  fake.reset();
  const r = await post('/api/cc/brain', { target: 'api', model: '[P]claude-opus-5-5', group: 'default' });
  assert.equal(r.status, 200);
  assert.deepEqual(lastTo('/brain').body, { target: 'api', api_model: '[P]claude-opus-5-5', api_group: 'default' });
  assert.equal((await r.json()).option.label, 'P');
});

test('brain POST：切到 API 不带模型 → 用上次选的；没选过用默认', async () => {
  fake.reset();
  await post('/api/cc/brain', { target: 'api' });
  assert.deepEqual(lastTo('/brain').body, { target: 'api', api_model: '[K]claude-opus-4-6-thinking', api_group: 'default' });
  fake.brain = { target: 'cc', api_model: '[B]claude-opus-4-5', api_group: 'default' };
  await post('/api/cc/brain', { target: 'api' });
  assert.deepEqual(lastTo('/brain').body, { target: 'api', api_model: '[B]claude-opus-4-5', api_group: 'default' });
});

test('brain POST：切回 CC 只带 target，选过的模型留在 bridge', async () => {
  fake.reset();
  useApi('[B]claude-opus-4-5');
  const data = await (await post('/api/cc/brain', { target: 'cc' })).json();
  assert.deepEqual(lastTo('/brain').body, { target: 'cc' });
  assert.equal(data.target, 'cc');
  assert.equal(data.model, '[B]claude-opus-4-5');
});

for (const [name, body] of [
  ['target 不对', { target: 'gpt' }],
  ['不认识的模型', { target: 'api', model: '[Z]claude-nope', group: 'default' }],
  ['模型和分组对不上', { target: 'api', model: 'claude-fable-5', group: 'default' }],
  ['只给模型不给分组', { target: 'api', model: '[B]claude-opus-4-5' }],
  ['分组 key 没配', { target: 'api', model: 'claude-fable-5', group: 'claude-awsb' }],
]) {
  test(`brain POST：${name} → 400，不转给 bridge`, async () => {
    fake.reset();
    assert.equal((await post('/api/cc/brain', body)).status, 400);
    assert.equal(fake.seen.filter((r) => r.url === '/brain' && r.method === 'POST').length, 0);
  });
}

test('brain POST：bridge 没有 /brain → 501', async () => {
  fake.reset();
  fake.hasBrain = false;
  assert.equal((await post('/api/cc/brain', { target: 'cc' })).status, 501);
});

// --- 一轮 API ---
test('CC 模式发消息：不调中转站', async () => {
  fake.reset();
  const data = await (await post('/api/cc/send', { text: 'hi' })).json();
  assert.equal(data.brain, 'cc');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fake.relayCalls.length, 0);
});

test('API 模式发消息：拼上文调选中的模型，回复和思考写回 bridge', async () => {
  fake.reset();
  useApi('[K]claude-opus-4-6-thinking');
  fake.addMessage({ id: 'old1', role: 'user', text: '早' });
  fake.addMessage({ id: 'old2', role: 'assistant', text: '早呀', pid: 'p1' });
  fake.addMessage({ id: 'old3', role: 'assistant', text: '睡得好吗', pid: 'p1' });
  const sent = await (await post('/api/cc/send', { text: '在吗' })).json();
  assert.equal(sent.brain, 'api');
  const reply = await waitFor(() => lastTo('/reply'));
  assert.equal(fake.relayCalls.length, 1);
  const call = fake.relayCalls[0];
  assert.equal(call.auth, 'Bearer key-default');
  assert.equal(call.body.model, '[K]claude-opus-4-6-thinking');
  assert.ok(call.body.max_tokens >= 8192);
  const [system, ...rest] = call.body.messages;
  assert.equal(system.role, 'system');
  assert.match(system.content, /bridge 给的人设/);
  assert.match(system.content, /【语音】/);
  assert.match(system.content, /没有任何工具/);
  assert.deepEqual(rest.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(rest[0].content, /^\[\d{2}-\d{2} \d{2}:\d{2}\] 早$/);
  assert.equal(rest[1].content, '早呀\n\n睡得好吗'); // 同一边连着的合成一条
  assert.match(rest[2].content, /在吗$/);
  assert.equal(reply.body.text, '嗯，我在。');
  assert.equal(reply.body.thinking, '她回来了，想一想怎么说。');
  assert.equal(reply.body.model, '[K]claude-opus-4-6-thinking');
  assert.equal(reply.body.group, 'default');
  assert.equal(reply.body.reply_to, sent.id);
  assert.match(reply.body.turn_id, /^api-/);
  assert.equal(lastTo('/typing').body.on, true);
});

test('API 模式：分组用自己的 key', async () => {
  fake.reset();
  useApi('claude-fable-5-1', 'claude-or');
  await post('/api/cc/send', { text: 'hi' });
  await waitFor(() => lastTo('/reply'));
  assert.equal(fake.relayCalls[0].auth, 'Bearer key-or');
  assert.equal(fake.relayCalls[0].body.model, 'claude-fable-5-1');
});

test('API 模式：连发几条只回一轮，回给最后一条', async () => {
  fake.reset();
  useApi();
  await post('/api/cc/send', { text: '一' });
  await post('/api/cc/send', { text: '二' });
  const second = await (await post('/api/cc/send', { text: '三' })).json();
  const reply = await waitFor(() => lastTo('/reply'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fake.relayCalls.length, 1);
  assert.equal(reply.body.reply_to, second.id);
  const msgs = fake.relayCalls[0].body.messages;
  assert.match(msgs[msgs.length - 1].content, /一\n.*二\n.*三$/s);
});

test('API 模式：回着的时候她又发了一条 → 回完再补一轮，上文里第一轮的回复排在新消息前面', async () => {
  fake.reset();
  useApi();
  fake.relayQueue.push({ content: '第一轮', delay: 400 });
  const first = await (await post('/api/cc/send', { text: '一' })).json();
  await waitFor(() => fake.relayCalls.length === 1);
  const second = await (await post('/api/cc/send', { text: '二' })).json();
  await waitFor(() => countTo('/reply') === 2);
  const replies = fake.seen.filter((r) => r.url === '/reply');
  assert.equal(replies[0].body.reply_to, first.id);
  assert.equal(replies[1].body.reply_to, second.id);
  const msgs = fake.relayCalls[1].body.messages.slice(1);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs[1].content, '第一轮');
  assert.match(msgs[2].content, /二$/);
});

test('API 模式：正文开头的 <think> 当思考过程，时间标记去掉', async () => {
  fake.reset();
  useApi('[B]claude-opus-4-6');
  fake.relayQueue.push({ content: '<thinking>先想想</thinking>\n[10-16 14:02] 好的呀' });
  await post('/api/cc/send', { text: 'hi' });
  const reply = await waitFor(() => lastTo('/reply'));
  assert.equal(reply.body.text, '好的呀');
  assert.equal(reply.body.thinking, '先想想');
});

test('API 模式：中转站报错 → bridge 记 reply_failed', async () => {
  fake.reset();
  useApi();
  fake.relayQueue.push({ status: 500, message: '上游炸了' });
  const sent = await (await post('/api/cc/send', { text: 'hi' })).json();
  const failed = await waitFor(() => lastTo('/system'));
  assert.equal(failed.body.kind, 'reply_failed');
  assert.equal(failed.body.reply_to, sent.id);
  assert.match(failed.body.error, /上游炸了/);
  assert.equal(countTo('/reply'), 0);
});

test('API 模式：模型只给思考不给正文 → reply_failed', async () => {
  fake.reset();
  useApi();
  fake.relayQueue.push({ content: '', reasoning_content: '想了半天' });
  await post('/api/cc/send', { text: 'hi' });
  const failed = await waitFor(() => lastTo('/system'));
  assert.match(failed.body.error, /没给正文/);
});

test('API 模式：再叫他一下（retry）→ 重跑一轮', async () => {
  fake.reset();
  useApi();
  const m = fake.addMessage({ id: 'u-retry', role: 'user', text: '还在吗' });
  const r = await post('/api/cc/retry', { id: m.id });
  assert.equal(r.status, 200);
  const reply = await waitFor(() => lastTo('/reply'));
  assert.equal(reply.body.reply_to, 'u-retry');
});

test('API 模式：已经回过的不再回（重发去重）', async () => {
  fake.reset();
  useApi();
  fake.addMessage({ id: 'u-dup', role: 'user', text: '在吗' });
  fake.addMessage({ id: 'a-dup', role: 'assistant', text: '在', via: 'api', reply_to: 'u-dup' });
  await post('/api/cc/retry', { id: 'u-dup' });
  await waitFor(() => fake.seen.some((r) => r.url === '/typing' && r.body.on === false));
  assert.equal(fake.relayCalls.length, 0);
  assert.equal(countTo('/reply'), 0);
});

test('API 模式：刚切过来时 CC 上一轮晚到的话不算回了她', async () => {
  fake.reset();
  useApi();
  const sent = await (await post('/api/cc/send', { text: '换你了' })).json();
  fake.addMessage({ id: 'cc-late', role: 'assistant', text: 'CC 上一轮的尾巴', pid: 'cc-p' });
  const reply = await waitFor(() => lastTo('/reply'));
  assert.equal(reply.body.reply_to, sent.id);
});

test('API 模式：重试较早那条时，后面同样没回上的（routed:api）一起回，回给最后一条', async () => {
  fake.reset();
  useApi();
  fake.addMessage({ id: 'r1', role: 'user', text: '第一条', routed: 'api' });
  fake.addMessage({ id: 'r2', role: 'user', text: '第二条', routed: 'api' });
  assert.equal((await post('/api/cc/retry', { id: 'r1' })).status, 200);
  const reply = await waitFor(() => lastTo('/reply'));
  assert.equal(reply.body.reply_to, 'r2');
  assert.match(fake.relayCalls[0].body.messages.at(-1).content, /第一条\n.*第二条$/s);
});

test('API 模式：更早没回上的不会被翻出来', async () => {
  fake.reset();
  useApi();
  fake.addMessage({ id: 'o1', role: 'user', text: '昨天那条', routed: 'api' });
  fake.addMessage({ id: 'o2', role: 'assistant', text: 'CC 回的', pid: 'cc' });
  const sent = await (await post('/api/cc/send', { text: '今天' })).json();
  const reply = await waitFor(() => lastTo('/reply'));
  assert.equal(reply.body.reply_to, sent.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(countTo('/reply'), 1);
});

test('API 模式：这一轮的图片转 base64 给模型看', async () => {
  fake.reset();
  useApi();
  await post('/api/cc/send', { text: '看', images: ['2026-10-16/a.png'] });
  await waitFor(() => lastTo('/reply'));
  const last = fake.relayCalls[0].body.messages.at(-1);
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[1].type, 'image_url');
  assert.match(last.content[1].image_url.url, /^data:image\/png;base64,/);
});

test('API 模式：模型不收图（400）就去掉图重试一次', async () => {
  fake.reset();
  useApi();
  fake.relayQueue.push({ status: 400, message: 'image not supported' });
  await post('/api/cc/send', { text: '看', images: ['2026-10-16/a.png'] });
  await waitFor(() => lastTo('/reply'));
  assert.equal(fake.relayCalls.length, 2);
  assert.equal(typeof fake.relayCalls[1].body.messages.at(-1).content, 'string');
  assert.match(fake.relayCalls[1].body.messages.at(-1).content, /\[图片\]/);
});

test('api-test：通的回 ok 和耗时，不通的回错误原文', async () => {
  fake.reset();
  fake.relayQueue.push({ content: 'pong' });
  const ok = await (await post('/api/cc/api-test', { model: '[K]claude-opus-4-7', group: 'default' })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'pong');
  assert.ok(ok.ms >= 0);
  fake.relayQueue.push({ status: 503, message: 'no available channel' });
  const bad = await (await post('/api/cc/api-test', { model: '[K]claude-opus-4-7', group: 'default' })).json();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no available channel/);
  const noKey = await (await post('/api/cc/api-test', { model: 'claude-fable-5', group: 'claude-ccmax' })).json();
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /RELAY_KEY_CLAUDE_CCMAX/);
  assert.equal((await post('/api/cc/api-test', { model: 'gpt-4o', group: 'default' })).status, 400);
});

// --- lib/apiTurn.js 进程内 ---
test('orderForModel：API 的回复挪到它回的那条后面，系统事件不算', () => {
  const out = orderForModel([
    { id: 'u1', role: 'user', seq: 1 },
    { id: 'u2', role: 'user', seq: 2 },
    { id: 'a1', role: 'assistant', seq: 3, via: 'api', reply_to: 'u1' },
    { id: 's1', role: 'system', seq: 4, kind: 'reply_failed' },
  ]);
  assert.deepEqual(out.map((m) => m.id), ['u1', 'a1', 'u2']);
});

test('splitThinking：reasoning 优先，正文里的 <think> 也剥掉', () => {
  assert.deepEqual(splitThinking('<think>a</think>b', 'r'), { text: 'b', thinking: 'r' });
  assert.deepEqual(splitThinking('[助手 10-16 14:02] 嗯', ''), { text: '嗯', thinking: '' });
  assert.deepEqual(splitThinking(null, undefined), { text: '', thinking: '' });
});

function fakeSupabase(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const b = {
        select: () => b, order: () => b, limit: () => b, eq: () => b,
        single: () => Promise.resolve({ data: rows[0] ?? null, error: rows.length ? null : { message: 'no rows' } }),
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      };
      return b;
    },
  };
}

test('进程内：bridge 没人设 → 退回 settings.system_prompt；带上记忆和日记；她后来发给 CC 的不算', async () => {
  const local = makeFake();
  local.persona = null;
  await new Promise((r) => local.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${local.server.address().port}`;
  try {
    local.brain = { target: 'api', api_model: '[B]claude-opus-4-5', api_group: 'default' };
    const turns = makeApiTurns({
      bridgeConfig: () => ({ url, token: 't' }),
      supabase: fakeSupabase({
        settings: [{ system_prompt: '设置里的人设', max_reply_tokens: 1000 }],
        memories: [{ summary: '记忆一' }],
        diaries: [{ content: '今天的日记', diary_date: '2026-10-15' }],
      }),
      voiceRule: '\n\n[voice]', formatTime: () => '10-16 14:00', estimateTokens: (t) => t.length,
      env: { RELAY_BASE_URL: `${url}/v1`, RELAY_API_KEY: 'k', API_TURN_DEBOUNCE_MS: '0' },
      log: { error() {} },
    });
    const mine = local.addMessage({ id: 'p1', role: 'user', text: '这条给 API', files: [{ path: '2026-10-16/n.txt', name: 'n.txt', size: 10 }] });
    local.addMessage({ id: 'p2', role: 'user', text: '这条后来给 CC 了' });
    turns.enqueue(mine.id);
    await waitFor(() => local.seen.find((r) => r.url === '/reply'));
    const { body } = local.relayCalls[0];
    assert.equal(body.max_tokens, 1000);
    assert.match(body.messages[0].content, /^设置里的人设\n\n\[voice\]/);
    assert.match(body.messages[0].content, /【过往记忆】\n记忆一/);
    assert.match(body.messages[0].content, /【你最近写的日记】\n2026-10-15：今天的日记/);
    assert.equal(body.messages.length, 2);
    assert.match(body.messages[1].content, /^\[10-16 14:00\] 这条给 API\n【文件 n.txt】\n文件里的字\n【文件 n.txt 完】$/);
  } finally {
    local.server.close();
  }
});

function localTurns(local, url, env = {}) {
  return makeApiTurns({
    bridgeConfig: () => ({ url, token: 't' }),
    supabase: fakeSupabase({ settings: [{ system_prompt: '设置里的人设' }] }),
    voiceRule: '', formatTime: () => '10-16 14:00', estimateTokens: (t) => t.length,
    env: { RELAY_BASE_URL: `${url}/v1`, RELAY_API_KEY: 'k', API_TURN_DEBOUNCE_MS: '0', ...env },
    log: { error() {} },
  });
}

test('进程内：回着的时候她又连发两条，跨过这一轮结束也合成一轮', async () => {
  const local = makeFake();
  await new Promise((r) => local.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${local.server.address().port}`;
  try {
    local.brain = { target: 'api', api_model: '[B]claude-opus-4-5', api_group: 'default' };
    const turns = localTurns(local, url, { API_TURN_DEBOUNCE_MS: '300' });
    local.relayQueue.push({ content: '第一轮', delay: 500 });
    turns.enqueue(local.addMessage({ id: 'd1', role: 'user', text: '一' }).id);
    await waitFor(() => local.relayCalls.length === 1);
    await new Promise((r) => setTimeout(r, 350));
    turns.enqueue(local.addMessage({ id: 'd2', role: 'user', text: '二' }).id); // 第一轮快结束时
    await waitFor(() => local.seen.some((r) => r.url === '/reply'));
    turns.enqueue(local.addMessage({ id: 'd3', role: 'user', text: '三' }).id); // 刚结束，还在 debounce 里
    await waitFor(() => local.seen.filter((r) => r.url === '/reply').length === 2);
    await new Promise((r) => setTimeout(r, 400));
    const replies = local.seen.filter((r) => r.url === '/reply');
    assert.equal(local.relayCalls.length, 2);
    assert.equal(replies.length, 2);
    assert.equal(replies[1].body.reply_to, 'd3');
  } finally {
    local.server.close();
  }
});

test('进程内：bridge 的人设一时拿不到不缓存，下一轮好了就用上', async () => {
  const local = makeFake();
  await new Promise((r) => local.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${local.server.address().port}`;
  try {
    local.brain = { target: 'api', api_model: '[B]claude-opus-4-5', api_group: 'default' };
    const turns = localTurns(local, url);
    local.persona = 'ERR';
    turns.enqueue(local.addMessage({ id: 'q1', role: 'user', text: '一' }).id);
    await waitFor(() => local.seen.some((r) => r.url === '/reply'));
    assert.match(local.relayCalls[0].body.messages[0].content, /^设置里的人设/);
    local.persona = '你是沐（bridge 给的人设）。';
    turns.enqueue(local.addMessage({ id: 'q2', role: 'user', text: '二' }).id);
    await waitFor(() => local.seen.filter((r) => r.url === '/reply').length === 2);
    assert.match(local.relayCalls[1].body.messages[0].content, /^你是沐（bridge 给的人设）/);
  } finally {
    local.server.close();
  }
});

// --- /api/chat 的压缩：交给 Claude，不用 DeepSeek ---
test('压缩：Claude 会话用它自己的模型压（走中转站，不走 DeepSeek），回完她再压', async () => {
  fake.reset();
  const session = await (await post('/api/sessions', { name: '沐', model: 'opus' })).json();
  const long = '今天的事'.repeat(220); // 约 1760 token 一条
  for (let i = 0; i < 16; i++) {
    const r = await post('/api/chat', { session_id: session.id, message: `${i} ${long}`, model: 'opus' });
    assert.equal(r.status, 200);
  }
  const call = await waitFor(() => fake.relayCalls.find((c) => JSON.stringify(c.body.messages).includes('记忆压缩助手')));
  assert.equal(call.body.model, '[C]claude-opus-4-6-thinking');
  assert.ok(call.body.max_tokens >= 4096);
  const memories = await waitFor(async () => {
    const list = await (await get('/api/memories')).json();
    return list.some((m) => m.summary === '压缩后的记忆') ? list : null;
  }).catch(() => null);
  assert.ok(memories, 'compressed memory saved');
});
