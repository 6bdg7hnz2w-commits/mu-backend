// 记忆包接班线：npm test
// 一个假服务同时当 bridge 和中转站；只看发给模型的东西对不对（模型答得好不好要真切一次才知道）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeApiTurns } = require('../lib/apiTurn');
const { makeCcDays } = require('../lib/ccDays');

process.env.RELAY_API_KEY = 'k'; // findOption 看 process.env 判断压缩链能不能用
const PACK = '# 你是沐\n\n## our-story.md\n下雪天\n\n## intimacy-talk.md\n很私密的话\n\n## mu-self.md\n我是沐\n\n# 今天和昨天的小事\n午饭牛肉面\n';
const MODEL = '[B]claude-opus-4-5';
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(5);
  }
  assert.fail('等不到');
}

function makeFake() {
  const f = { history: [], replies: [], relay: [], relayQueue: [], pack: PACK, ctx: { capsule: null, health: null, pins: [], today: [] }, brain: { target: 'api', api_model: MODEL, api_group: 'default', switched_at: '2026-11-01T00:00:00.000Z' } };
  f.say = (n, role, text) => {
    const m = { id: `m${n}`, seq: n, role, text, time: new Date(Date.parse('2026-11-02T00:00:00Z') + n * 60000).toISOString(), ...(role === 'assistant' ? { via: 'api', reply_to: `m${n - 1}` } : { routed: 'api' }) };
    f.history.push(m);
    return m;
  };
  f.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/v1/')) {
        const compress = JSON.stringify(body.messages).includes('记忆压缩助手');
        f.relay.push({ body, compress });
        if (compress) return send(200, { choices: [{ message: { role: 'assistant', content: `摘要：${/第5条的梗/.test(JSON.stringify(body.messages)) ? '香菜星人的梗' : '别的'}` } }] });
        const next = f.relayQueue.shift();
        if (next?.status) return send(next.status, { error: { message: next.message } });
        return send(200, { choices: [{ message: { role: 'assistant', content: next?.content || '嗯' } }], usage: f.usageQueue?.shift() });
      }
      if (url.pathname === '/pack') return f.pack ? send(200, { text: f.pack }) : send(404, {});
      if (url.pathname === '/turn-context') return send(200, f.ctx);
      if (url.pathname === '/brain') return send(200, f.brain);
      if (url.pathname === '/file-types') return send(200, { types: [] });
      if (url.pathname === '/persona') return send(200, { text: '人设' });
      if (url.pathname === '/typing' || url.pathname === '/system') return send(200, { ok: true });
      if (url.pathname === '/history') {
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit'));
        const list = before ? f.history.filter((m) => m.time < before) : f.history;
        return send(200, { messages: list.slice(-limit) });
      }
      if (url.pathname === '/reply') { f.replies.push(body); return send(200, { id: `r${f.replies.length}`, text: body.text }); }
      send(404, {});
    });
  });
  return f;
}

function fakeSupabase(tables, calls = []) {
  return {
    from(table) {
      tables[table] = tables[table] || [];
      const b = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k, v) => { calls.push(`${table}.${k}=${v}`); return b; },
        insert: (row) => { tables[table].push({ created_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null }); },
        single: () => Promise.resolve({ data: tables[table][0] ?? null, error: null }),
        then: (res, rej) => Promise.resolve({ data: table === 'memories' ? [...tables[table]].reverse() : tables[table], error: null }).then(res, rej),
      };
      // sessionRows 要旧的在前、compressedUpto 要新的在前：按 order 的方向来
      b.order = (_, o) => { b.asc = o?.ascending; return b; };
      b.then = (res, rej) => {
        const rows = table === 'memories' && !b.asc ? [...tables[table]].reverse() : tables[table];
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      };
      return b;
    },
  };
}

async function setup(run, { tables = {}, env = {}, calls } = {}) {
  const f = makeFake();
  await new Promise((r) => f.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${f.server.address().port}`;
  const db = { settings: [{ compress_threshold: 999999, compress_keep_rounds: 15 }], ...tables };
  const turns = makeApiTurns({
    bridgeConfig: () => ({ url, token: 't' }), supabase: fakeSupabase(db, calls), voiceRule: '',
    formatTime: () => '11-02 08:00', estimateTokens: (t) => t.length,
    env: { RELAY_BASE_URL: `${url}/v1`, RELAY_API_KEY: 'k', API_TURN_DEBOUNCE_MS: '0', ...env }, log: { error() {}, log() {} },
  });
  try {
    await run(f, turns, db);
  } finally {
    f.server.close();
    f.server.closeAllConnections?.();
  }
}

const chatCalls = (f) => f.relay.filter((c) => !c.compress);
const systemText = (c) => { const s = c.body.messages[0].content; return typeof s === 'string' ? s : s[0].text; };
const allText = (c) => JSON.stringify(c.body.messages.slice(1));
async function ask(f, turns, n, text) {
  const before = f.replies.length;
  turns.enqueue(f.say(n, 'user', text).id);
  await waitFor(() => f.replies.length > before);
  f.say(n + 1, 'assistant', '嗯');
}

test('记忆包当 system 前缀：带 cache_control，两轮之间一字不变；会变的挂在她最后一条后面', async () => {
  await setup(async (f, turns) => {
    f.ctx = { capsule: '她在：洗澡·已过 3 分钟/预计 25', health: null, pins: ['她不吃香菜'], today: [{ key: '午饭', value: '牛肉面' }] };
    await ask(f, turns, 1, '一');
    f.ctx = { ...f.ctx, capsule: '她在：洗澡·已过 8 分钟/预计 25' };
    await ask(f, turns, 3, '二');
    const [a, b] = chatCalls(f);
    assert.equal(a.body.messages[0].content[0].cache_control.type, 'ephemeral');
    assert.ok(systemText(a).startsWith(PACK));
    assert.equal(systemText(a), systemText(b));
    assert.doesNotMatch(systemText(b), /洗澡/);
    const last = b.body.messages[b.body.messages.length - 1].content;
    assert.match(last, /【现在】\n她在：洗澡·已过 8 分钟\/预计 25\n钉住的事：\n- 她不吃香菜\n今天记下的：午饭：牛肉面$/);
  });
});

test('中转不认 cache_control（400）：退回字符串，之后不再试', async () => {
  await setup(async (f, turns) => {
    f.relayQueue.push({ status: 400, message: 'unknown field cache_control' });
    await ask(f, turns, 1, '一');
    await ask(f, turns, 3, '二');
    const calls = chatCalls(f);
    assert.equal(calls.length, 3);
    assert.equal(typeof calls[1].body.messages[0].content, 'string');
    assert.equal(typeof calls[2].body.messages[0].content, 'string');
  });
});

test('上游拦内容：拿掉最私密的那份再试一次，别的记忆还在', async () => {
  await setup(async (f, turns) => {
    f.relayQueue.push({ status: 503, message: '内容违规已被上游拒绝' });
    await ask(f, turns, 1, '一');
    const [first, second] = chatCalls(f);
    assert.match(systemText(first), /很私密的话/);
    assert.doesNotMatch(systemText(second), /很私密的话/);
    assert.match(systemText(second), /我是沐/);
    assert.match(systemText(second), /午饭牛肉面/);
    assert.equal(f.replies.length, 1);
  });
});

test('验收：聊满 100 条后提第 5 条的梗，原文还在上文里', async () => {
  await setup(async (f, turns) => {
    for (let n = 1; n <= 100; n++) f.say(n, n % 2 ? 'user' : 'assistant', n === 5 ? '第5条的梗：香菜星人' : `话${n}`);
    await ask(f, turns, 101, '还记得香菜星人吗');
    assert.match(allText(chatCalls(f)[0]), /第5条的梗/);
  });
});

test('验收：聊到压缩线以后，梗从原文进了会话摘要，放在最前，不直接丢', async () => {
  await setup(async (f, turns, db) => {
    for (let n = 1; n <= 130; n++) f.say(n, n % 2 ? 'user' : 'assistant', n === 5 ? '第5条的梗：香菜星人' : `话${n}`);
    await ask(f, turns, 131, '一');
    await waitFor(() => db.memories?.length === 1);
    await ask(f, turns, 133, '还记得香菜星人吗');
    const call = chatCalls(f).pop();
    assert.doesNotMatch(allText(call), /第5条的梗/);
    assert.match(call.body.messages[1].content, /^【本次会话摘要，更早的话在这里】\n摘要：香菜星人的梗/);
    assert.ok(systemText(call).startsWith(PACK));
  });
});

test('不叠压：满 3 层从原始聊天重新生成，旧的几层作废', async () => {
  const old = (i) => ({ summary: `旧层${i}`, session_id: 'cc', created_at: new Date().toISOString(), metadata: { upto_time: new Date(Date.parse('2026-11-02T00:00:00Z') + i * 60000).toISOString() } });
  await setup(async (f, turns, db) => {
    for (let n = 1; n <= 130; n++) f.say(n, n % 2 ? 'user' : 'assistant', n === 5 ? '第5条的梗：香菜星人' : `话${n}`);
    await ask(f, turns, 131, '一');
    await waitFor(() => db.memories.length === 4);
    assert.equal(db.memories[3].metadata.rebuilt, true);
    assert.match(db.memories[3].summary, /香菜星人/);
    await ask(f, turns, 133, '二');
    const call = chatCalls(f).pop();
    assert.doesNotMatch(call.body.messages[1].content, /旧层/);
  }, { tables: { memories: [old(1), old(2), old(3)] } });
});

test('验收：她纠正的事钉住以后，过 50 条每轮都还带着', async () => {
  await setup(async (f, turns) => {
    f.ctx = { ...f.ctx, pins: ['她说不是护照，是港澳通行证'] };
    for (let n = 1; n <= 50; n++) f.say(n, n % 2 ? 'user' : 'assistant', `话${n}`);
    await ask(f, turns, 51, '我那个证是啥来着');
    assert.match(allText(chatCalls(f)[0]), /不是护照，是港澳通行证/);
  });
});

test('没有记忆包：退回老拼法，这一轮照样回；日记只查公开的', async () => {
  const calls = [];
  await setup(async (f, turns) => {
    f.pack = null;
    await ask(f, turns, 1, '一');
    assert.equal(typeof chatCalls(f)[0].body.messages[0].content, 'string');
    assert.match(systemText(chatCalls(f)[0]), /^人设/);
    assert.ok(calls.includes('diaries.visibility=public'));
  }, { calls });
});

test('每日摘要：压完写回 bridge；失败留着下次再试，没 key 什么都不做', async () => {
  const posts = [];
  let date = '2026-11-05';
  const bridgeFetch = async (p, o) => {
    if (p === '/days/pending') return { ok: true, data: date ? { date, open: [], today: {}, transcript: '[t] 她：牙疼' } : { date: null } };
    posts.push(o.body);
    date = null;
    return { ok: true };
  };
  const realFetch = global.fetch;
  let sent = null;
  global.fetch = async (u, o) => {
    sent = JSON.parse(o.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"happened":["牙疼"]}' } }] }) };
  };
  try {
    await makeCcDays({ bridgeFetch, env: {}, log: { error() {}, log() {} } }).kick();
    assert.equal(sent, null);
    await makeCcDays({ bridgeFetch, env: { DEEPSEEK_API_KEY: 'k' }, log: { error() {}, log() {} } }).kick();
    assert.equal(posts[0].date, '2026-11-05');
    assert.deepEqual(posts[0].summary.happened, ['牙疼']);
    assert.match(sent.messages[0].content, /问过和做了/);
    date = '2026-11-06';
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const days = makeCcDays({ bridgeFetch, env: { DEEPSEEK_API_KEY: 'k' }, log: { error() {}, log() {} } });
    await days.kick();
    assert.equal(posts.length, 1);
    assert.match(days.status().last_error, /2026-11-06/);
  } finally {
    global.fetch = realFetch;
  }
});

test('作废的回复不发给模型，也不算回过：同一条能再答一次', async () => {
  await setup(async (f, turns) => {
    f.say(1, 'user', '明天几点');
    const old = f.say(2, 'assistant', '旧回复十点');
    old.reply_to = 'm1';
    old.superseded = true;
    turns.enqueue('m1');
    await waitFor(() => f.replies.length === 1);
    assert.doesNotMatch(allText(chatCalls(f)[0]), /旧回复十点/);
    assert.equal(f.replies[0].reply_to, 'm1');
  });
});

test('她改了更早的话：说明附在她这轮最前，只在这一轮；回上来带 ack', async () => {
  await setup(async (f, turns) => {
    f.ctx = { ...f.ctx, edit_notes: [{ id: 'm1', line: '她把 11-02 08:00 时的消息从「旧」改成了「新」' }] };
    await ask(f, turns, 1, '一');
    const call = chatCalls(f)[0];
    assert.match(call.body.messages[call.body.messages.length - 1].content, /^\[系统说明，不是她这次说的：她把 11-02 08:00 时的消息从「旧」改成了「新」\]\n/);
    assert.deepEqual(f.replies[0].edit_notes_ack, ['m1']);
    f.ctx = { ...f.ctx, edit_notes: [] }; // bridge 收到 ack 就清了
    await ask(f, turns, 3, '二');
    assert.doesNotMatch(allText(chatCalls(f)[1]), /系统说明/);
    assert.equal(f.replies[1].edit_notes_ack, undefined);
  });
});

test('这一轮失败了：不 ack，说明下一轮还在', async () => {
  await setup(async (f, turns) => {
    f.ctx = { ...f.ctx, edit_notes: [{ id: 'm1', line: 'x' }] };
    f.relayQueue.push({ status: 500, message: 'boom' });
    turns.enqueue(f.say(1, 'user', '一').id);
    await waitFor(() => f.relay.length >= 1);
    await sleep(30);
    assert.equal(f.replies.length, 0);
  });
});

test('防抖：打字期间不触发，停下再等够，20 秒上限（这里按比例缩小）', async () => {
  await setup(async (f, turns) => {
    turns.enqueue(f.say(1, 'user', '一').id);
    const start = Date.now();
    const typing = setInterval(() => turns.composing(true), 20);
    await sleep(150);
    assert.equal(chatCalls(f).length, 0); // 过了 debounce，她还在打
    clearInterval(typing);
    await waitFor(() => chatCalls(f).length === 1);
    assert.ok(Date.now() - start >= 150 + 40, '停下以后还要等一个 debounce');

    const t2 = Date.now();
    const forever = setInterval(() => turns.composing(true), 20);
    turns.enqueue(f.say(3, 'user', '二').id);
    await waitFor(() => chatCalls(f).length === 2);
    clearInterval(forever);
    const waited = Date.now() - t2;
    assert.ok(waited >= 380 && waited < 700, `一直打字也到上限就回：${waited}`);
  }, { env: { API_TURN_DEBOUNCE_MS: '60', API_TURN_MAX_WAIT_MS: '400' } });
});

test('防抖：清空输入框马上按发消息算；没有待回的消息时打字什么都不做', async () => {
  await setup(async (f, turns) => {
    turns.composing(true);
    await sleep(100);
    assert.equal(chatCalls(f).length, 0);
    turns.enqueue(f.say(1, 'user', '一').id);
    turns.composing(true);
    await sleep(20);
    turns.composing(false);
    await waitFor(() => chatCalls(f).length === 1);
  }, { env: { API_TURN_DEBOUNCE_MS: '60' } });
});

test('缓存探测：同一份记忆包发两次，读得出 Anthropic 和 OpenAI 两种 usage', async () => {
  await setup(async (f, turns) => {
    f.usageQueue = [{ prompt_tokens: 100, cache_creation_input_tokens: 90 }, { prompt_tokens: 100, cache_read_input_tokens: 90 }];
    const r = await turns.cacheProbe();
    assert.equal(r.first.cache_write, 90);
    assert.equal(r.second.cache_read, 90);
    assert.equal(r.cached, true);
    assert.equal(systemText(f.relay[0]), systemText(f.relay[1]));
    assert.equal(systemText(f.relay[0]), PACK);
    f.usageQueue = [{ prompt_tokens: 100 }, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }];
    assert.equal((await turns.cacheProbe()).cached, false);
    f.usageQueue = [{ prompt_tokens: 100 }, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }];
    assert.equal((await turns.cacheProbe()).cached, true);
  }, { env: { API_CACHE_PROBE_WAIT_MS: '0' } });
});
