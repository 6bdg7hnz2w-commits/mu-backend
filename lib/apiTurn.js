// 沐 (CC) 聊天切到 API 时，后端替他回：从 bridge 拉上文 → 调中转站模型 → 把回复写回 bridge。
// 记录只有 bridge 那一份，所以聊天页、历史、SSE 都还是同一条线。接口约定见 docs/api-mode.md。
const OpenAI = require('openai');
const { DEFAULT_OPTION, COMPRESS_CHAIN, findOption, relayKeyFor, keyEnvName } = require('./apiModels');
const { fetchFileTypes } = require('./ccFiles');

const HISTORY_LIMIT = 60;
const CONTEXT_TOKEN_BUDGET = 30000;  // 按 estimateTokens 估的，图片每张另算 IMAGE_TOKENS
const IMAGE_TOKENS = 1500;
const MAX_IMAGES = 4;                // 只给这一轮要回的消息里的图，最多几张
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // 上游按 base64 后算 5MB，原图得再小三成
const MAX_INLINE_FILE_BYTES = 64 * 1024;
const PERSONA_CACHE_MS = 5 * 60 * 1000;
const DIARY_MAX_CHARS = 2000;
const COMPRESS_HISTORY_LIMIT = 200;
const RHYTHM_HEAD = '\n\n【指尖的语气——以下是桦桦打这条消息的节奏，供你感受她当下的状态，不要复述具体数字，也不要主动提起】\n';
const COMPRESS_PROMPT = '你是一个记忆压缩助手。请将对话压缩成简短的记忆摘要，保留关键信息、情感和重要细节，用第三人称描述。对话里"她"是桦桦，"沐"是她的伴侣。';

const API_NOTE = '\n\n【现在的情况】这会儿你是通过 API 在回她（VPS 上的 Claude Code 暂时没在接消息），这一轮你没有任何工具：' +
  '不能读写文件、不能跑命令、不能查东西，只能直接说话。别答应去做要用工具的事，真要做就说等回到 CC 再弄。' +
  '她每条消息前面的 [MM-DD HH:mm] 是她发消息的时间，你回复里不要写这种时间标记。';

// 模型偶尔学着在开头写时间标记，回之前去掉
const LEADING_STAMP_RE = /^\s*\[(?:用户|助手|她|你)?\s*\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]\s*/;
// 有的渠道把思考过程直接写在正文开头
const THINK_BLOCK_RE = /^\s*<(think|thinking)>([\s\S]*?)<\/\1>\s*/;

const ROLES = new Set(['user', 'assistant']);
const hasSeq = (m) => Number.isSafeInteger(m.seq);

// 给模型看的先后：都有 seq 按 seq，否则按时间。API 回的那条挪到它 reply_to 那条后面
// （她在 API 回的时候又发了一条，bridge 给回复的 seq 会比那条大，不挪的话模型会以为那条已经回过了）
function orderForModel(messages) {
  const list = messages.filter((m) => m && ROLES.has(m.role) && typeof m.id === 'string');
  const bySeq = list.every(hasSeq);
  list.sort((a, b) => (bySeq ? a.seq - b.seq : new Date(a.time) - new Date(b.time)));
  const ids = new Set(list.map((m) => m.id));
  const moved = list.filter((m) => m.via === 'api' && m.reply_to && ids.has(m.reply_to) && m.reply_to !== m.id);
  const out = list.filter((m) => !moved.includes(m));
  for (const m of moved) {
    let i = out.findIndex((x) => x.id === m.reply_to);
    if (i < 0) { out.push(m); continue; }
    while (i + 1 < out.length && out[i + 1].role === 'assistant') i++;
    out.splice(i + 1, 0, m);
  }
  return out;
}

function splitThinking(content, reasoning) {
  let text = typeof content === 'string' ? content : '';
  let thinking = typeof reasoning === 'string' ? reasoning.trim() : '';
  const m = THINK_BLOCK_RE.exec(text);
  if (m) {
    if (!thinking) thinking = m[2].trim();
    text = text.slice(m[0].length);
  }
  return { text: text.replace(LEADING_STAMP_RE, '').trim(), thinking };
}

function errorText(err) {
  return String(err?.message || err || 'unknown error').slice(0, 300);
}

function makeApiTurns({ bridgeConfig, supabase, voiceRule = '', formatTime, estimateTokens, onReply, env = process.env, log = console }) {
  const debounceMs = Number(env.API_TURN_DEBOUNCE_MS ?? 2500);
  const timeoutMs = Number(env.API_TURN_TIMEOUT_MS || 180000);
  const baseURL = env.RELAY_BASE_URL || 'https://cn.jixiangai.xyz/v1';

  // --- bridge ---
  async function bridgeFetch(path, { method = 'GET', body, timeout = 15000, raw = false } = {}) {
    const bridge = bridgeConfig();
    if (!bridge) throw new Error('bridge not configured');
    const headers = { 'Authorization': `Bearer ${bridge.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${bridge.url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)
    });
    if (raw) return r;
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, data };
  }
  const bridgePost = (path, body) => bridgeFetch(path, { method: 'POST', body });

  // null = bridge 还没有 /brain（没更新）
  async function getBrain() {
    const r = await bridgeFetch('/brain');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    return r.data;
  }

  // 选中的模型：bridge 里记的不在目录里了（改过名之类）就用默认的
  function resolveOption(brain) {
    return findOption(brain?.api_model, brain?.api_group) || findOption(DEFAULT_OPTION.model, DEFAULT_OPTION.group);
  }

  // --- 模型 ---
  const clients = new Map(); // key → OpenAI client
  function clientFor(group) {
    const apiKey = relayKeyFor(group, env);
    if (!apiKey) throw new Error(`中转站的 key 没配（Render 环境变量 RELAY_API_KEY，或者分组单独的 ${keyEnvName(group)}）`);
    if (!clients.has(apiKey)) clients.set(apiKey, new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 0 }));
    return clients.get(apiKey);
  }

  async function complete(option, messages, maxTokens) {
    const response = await clientFor(option.group).chat.completions.create({ model: option.model, max_tokens: maxTokens, messages });
    if (!response?.choices?.length) throw new Error(response?.error?.message || '中转站没有返回 choices');
    const msg = response.choices[0].message || {};
    return splitThinking(msg.content, msg.reasoning_content || msg.thinking);
  }

  // --- 人设、记忆 ---
  // 只有 bridge 明说没有（404）才记成"没有"；一时连不上就先用上次拿到的，下次再问，别为一次抖动退回旧人设 5 分钟
  let personaCache = null; // { at, text }
  async function bridgePersona() {
    if (personaCache && Date.now() - personaCache.at < PERSONA_CACHE_MS) return personaCache.text;
    try {
      const r = await bridgeFetch('/persona');
      if (r.ok || r.status === 404) {
        const text = r.ok && typeof r.data?.text === 'string' && r.data.text.trim() ? r.data.text.trim() : null;
        personaCache = { at: Date.now(), text };
        return text;
      }
      log.error('API turn persona error: bridge', r.status);
    } catch (err) {
      log.error('API turn persona error:', err.message);
    }
    return personaCache?.text ?? null;
  }

  async function buildSystem(settings) {
    const persona = (await bridgePersona()) || settings?.system_prompt || '你是沐，桦桦的伴侣。说话温柔自然，不端着。';
    const [{ data: memories }, { data: diaries }] = await Promise.all([
      supabase.from('memories').select('summary').order('timestamp', { ascending: false }).limit(10),
      supabase.from('diaries').select('content, diary_date, created_at').eq('author', 'mu').order('created_at', { ascending: false }).limit(2),
    ]);
    let system = persona + voiceRule + API_NOTE;
    if (memories?.length) system += '\n\n【过往记忆】\n' + memories.map((m) => m.summary).join('\n---\n');
    if (diaries?.length) {
      system += '\n\n【你最近写的日记】\n' + diaries.slice().reverse()
        .map((d) => `${d.diary_date || String(d.created_at || '').slice(0, 10)}：${String(d.content || '').slice(0, DIARY_MAX_CHARS)}`).join('\n---\n');
    }
    return system;
  }

  // --- 附件 ---
  async function fetchUpload(path) {
    const [date, file] = String(path).split('/').slice(-2);
    if (!date || !file) return null;
    const r = await bridgeFetch(`/uploads/${encodeURIComponent(date)}/${encodeURIComponent(file)}`, { raw: true, timeout: 30000 });
    if (!r.ok) return null;
    return { type: (r.headers.get('content-type') || '').split(';')[0].trim(), buffer: Buffer.from(await r.arrayBuffer()) };
  }

  // 这一轮要回的消息：图片转 base64 给模型看，小的文本文件内联；拿不到就降级成一句提示
  async function attachmentParts(m, budget, textExts) {
    const notes = [];
    const images = [];
    for (const path of Array.isArray(m.images) ? m.images : []) {
      if (budget.images <= 0) { notes.push('[图片]'); continue; }
      try {
        const got = await fetchUpload(path);
        if (!got || !got.type.startsWith('image/') || got.buffer.length > MAX_IMAGE_BYTES) { notes.push('[图片]'); continue; }
        images.push({ type: 'image_url', image_url: { url: `data:${got.type};base64,${got.buffer.toString('base64')}` } });
        budget.images--;
      } catch (err) {
        log.error('API turn image error:', err.message);
        notes.push('[图片]');
      }
    }
    for (const f of Array.isArray(m.files) ? m.files : []) {
      const name = typeof f?.name === 'string' ? f.name : '文件';
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (textExts.has(ext) && typeof f.path === 'string' && !(f.size > MAX_INLINE_FILE_BYTES)) {
        try {
          const got = await fetchUpload(f.path);
          if (got && got.buffer.length <= MAX_INLINE_FILE_BYTES && !got.buffer.includes(0)) {
            notes.push(`【文件 ${name}】\n${got.buffer.toString('utf8')}\n【文件 ${name} 完】`);
            continue;
          }
        } catch (err) {
          log.error('API turn file error:', err.message);
        }
      }
      notes.push(`[文件: ${name}]`);
    }
    return { notes, images };
  }

  function plainMarkers(m) {
    const notes = [];
    if (Array.isArray(m.images) && m.images.length) notes.push(m.images.length > 1 ? `[${m.images.length} 张图片]` : '[图片]');
    for (const f of Array.isArray(m.files) ? m.files : []) notes.push(`[文件: ${typeof f?.name === 'string' ? f.name : '文件'}]`);
    return notes;
  }

  // 拼给模型的 messages：同一边连着的合成一条；从后往前按预算截；开头必须是她说的
  async function buildMessages(context, answerIds, withImages) {
    let textExts = new Set();
    try {
      const types = await fetchFileTypes(bridgeConfig());
      textExts = new Set(types.types.filter((t) => t.kind === 'text').map((t) => t.ext));
    } catch {}
    const budget = { images: withImages ? MAX_IMAGES : 0 };
    const items = [];
    // 从新到旧取图，最新的几张优先
    for (let i = context.length - 1; i >= 0; i--) {
      const m = context[i];
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (m.role === 'assistant') {
        if (text) items.unshift({ role: 'assistant', text, images: [] });
        continue;
      }
      const { notes, images } = answerIds.has(m.id) ? await attachmentParts(m, budget, textExts) : { notes: plainMarkers(m), images: [] };
      const body = [text, ...notes].filter(Boolean).join('\n') || '[图片]';
      if (!text && !notes.length && !images.length) continue;
      const stamp = Number.isNaN(Date.parse(m.time)) ? '' : `[${formatTime(m.time)}] `;
      items.unshift({ role: 'user', text: stamp + body, images });
    }

    const merged = [];
    for (const it of items) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === it.role) {
        prev.text += it.role === 'user' ? '\n' : '\n\n';
        prev.text += it.text;
        prev.images.push(...it.images);
      } else merged.push({ ...it, images: [...it.images] });
    }

    let used = 0;
    let start = merged.length;
    while (start > 0) {
      const it = merged[start - 1];
      const cost = estimateTokens(it.text) + it.images.length * IMAGE_TOKENS;
      if (used + cost > CONTEXT_TOKEN_BUDGET && start < merged.length) break;
      used += cost;
      start--;
    }
    const kept = merged.slice(start);
    while (kept.length && kept[0].role !== 'user') kept.shift();
    return {
      hadImages: kept.some((it) => it.images.length),
      messages: kept.map((it) => ({
        role: it.role,
        content: it.images.length ? [{ type: 'text', text: it.text }, ...it.images] : it.text,
      })),
    };
  }

  // --- 一轮 ---
  const pending = new Set(); // 她发来、等 API 回的消息 id
  let timer = null;
  let running = false;

  function enqueue(id) {
    if (typeof id !== 'string' || !id) return;
    pending.add(id);
    lastEnqueueAt = Date.now();
    if (running) return; // 正在回的这轮结束后会接着处理
    clearTimeout(timer);
    timer = setTimeout(drain, debounceMs);
  }

  // 一次只跑一轮。回着的时候她又发了：这轮完了也照样从她最后一条算起等满 debounce，连发的几条才不会被拆成两轮
  let lastEnqueueAt = 0;
  async function drain() {
    timer = null;
    if (running) return;
    running = true;
    try {
      await runTurn();
    } finally {
      running = false;
    }
    if (pending.size) timer = setTimeout(drain, Math.max(0, lastEnqueueAt + debounceMs - Date.now()));
  }

  async function reportFailure(replyTo, err) {
    log.error('API turn failed:', errorText(err));
    if (!replyTo) return;
    try {
      const r = await bridgePost('/system', { kind: 'reply_failed', reply_to: replyTo, error: errorText(err) });
      if (!r.ok) log.error('API turn reply_failed not recorded:', r.status);
    } catch (e) {
      log.error('API turn reply_failed error:', e.message);
    }
  }

  async function runTurn() {
    const batch = [...pending];
    batch.forEach((id) => pending.delete(id));
    let replyTo = batch[batch.length - 1];
    try {
      await bridgePost('/typing', { on: true }).catch(() => {});
      const [brain, history, settingsRes] = await Promise.all([
        getBrain(),
        bridgeFetch(`/history?limit=${HISTORY_LIMIT}`),
        supabase.from('settings').select('*').single(),
      ]);
      if (!history.ok) throw new Error(`bridge history ${history.status}`);
      const ordered = orderForModel(history.data?.messages || []);

      // 要回的：待回集合里的，后面还没有 API 回过的话（重发去重、已经回过的不再回）。也顺手带上这期间新到的，
      // 以及从最早那条往后、bridge 标了 routed:"api" 但还没回上的（重试较早那条时，后面没回上的不会被落下）。
      // 只认 API 的回复：这些消息 CC 没见过，刚切过来时 CC 上一轮晚到的话不算回了她
      const wanted = new Set(batch);
      for (const id of pending) wanted.add(id);
      const firstWanted = ordered.findIndex((m) => wanted.has(m.id));
      const answerIds = new Set();
      ordered.forEach((m, i) => {
        if (m.role !== 'user' || firstWanted < 0 || i < firstWanted || !(wanted.has(m.id) || m.routed === 'api')) return;
        if (!ordered.slice(i + 1).some((x) => x.role === 'assistant' && x.via === 'api')) answerIds.add(m.id);
      });
      answerIds.forEach((id) => pending.delete(id));
      if (!answerIds.size) {
        const found = ordered.some((m) => wanted.has(m.id));
        if (found) { await bridgePost('/typing', { on: false }).catch(() => {}); return; } // 都回过了
        throw new Error('bridge 历史里找不到要回的消息');
      }
      const lastIdx = ordered.reduce((acc, m, i) => (answerIds.has(m.id) ? i : acc), -1);
      replyTo = ordered[lastIdx].id;
      // 她后来发给 CC 的不算进这一轮；已经压进记忆的那段不再原文给（记忆在 system 里）
      const upto = await compressedUpto();
      const context = ordered.slice(0, lastIdx + 1).filter((m) => !upto || answerIds.has(m.id) || Date.parse(m.time) > upto);

      const option = resolveOption(brain)?.option;
      if (!option) throw new Error('没有可用的模型');
      const settings = settingsRes?.data || null;
      const baseMax = settings?.max_reply_tokens || 4096;
      const maxTokens = option.thinking ? Math.max(baseMax, 8192) : baseMax;
      // 她这几条是怎么打出来的（bridge 存在消息的 rhythm 上）：只给感受，不复述数字
      const rhythm = context.filter((m) => answerIds.has(m.id) && typeof m.rhythm === 'string' && m.rhythm.trim()).map((m) => m.rhythm.trim());
      const system = (await buildSystem(settings)) + (rhythm.length ? RHYTHM_HEAD + rhythm.join('；') : '');

      let built = await buildMessages(context, answerIds, true);
      let result;
      try {
        result = await complete(option, [{ role: 'system', content: system }, ...built.messages], maxTokens);
      } catch (err) {
        // 模型不收图（400）就去掉图再试一次
        if (!(built.hadImages && err?.status === 400)) throw err;
        built = await buildMessages(context, answerIds, false);
        result = await complete(option, [{ role: 'system', content: system }, ...built.messages], maxTokens);
      }
      if (!result.text) throw new Error('模型没给正文');

      const turnId = `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const reply = { text: result.text, ...(result.thinking ? { thinking: result.thinking } : {}), model: option.model, group: option.group, reply_to: replyTo, turn_id: turnId };
      let r;
      try {
        r = await bridgePost('/reply', reply);
      } catch {
        r = await bridgePost('/reply', reply); // 同一个 turn_id，bridge 不会存两条
      }
      if (!r.ok) throw new Error(`bridge reply ${r.status}`);
      try { onReply?.(r.data?.id || turnId, result.text); } catch (e) { log.error('API turn onReply error:', e.message); }
      maybeCompress(settings).catch((e) => log.error('API compress error:', e.message));
    } catch (err) {
      await reportFailure(replyTo, err);
    }
  }

  // --- 压缩 ---
  // 聊天记录在 bridge 里一直留着；压缩只是把较早的一段写成一条记忆（memories，session_id 'cc'），
  // metadata.upto_time 记到哪条为止，之后 API 拼上文就从那以后开始。阈值沿用 settings 里的 compress_threshold / compress_keep_rounds
  async function compressedUpto() {
    const { data } = await supabase.from('memories').select('metadata').eq('session_id', 'cc').order('created_at', { ascending: false }).limit(1);
    const t = Date.parse(data?.[0]?.metadata?.upto_time);
    return Number.isFinite(t) ? t : 0;
  }

  let compressingNow = false;
  async function maybeCompress(settings) {
    if (compressingNow) return;
    compressingNow = true;
    try {
      const threshold = settings?.compress_threshold || 12000;
      const keepCount = (settings?.compress_keep_rounds || 15) * 2;
      const [history, upto] = await Promise.all([bridgeFetch(`/history?limit=${COMPRESS_HISTORY_LIMIT}`), compressedUpto()]);
      if (!history.ok) throw new Error(`bridge history ${history.status}`);
      const fresh = orderForModel(history.data?.messages || [])
        .filter((m) => Date.parse(m.time) > upto && (typeof m.text === 'string' && m.text.trim() || m.images?.length || m.files?.length));
      const tokens = fresh.reduce((n, m) => n + estimateTokens(m.text || ''), 0);
      if (tokens < threshold || fresh.length <= keepCount) return;

      const toCompress = fresh.slice(0, fresh.length - keepCount);
      const transcript = toCompress.map((m) => {
        const who = m.role === 'user' ? '她' : '沐';
        const body = [String(m.text || '').trim(), ...plainMarkers(m)].filter(Boolean).join(' ');
        return `[${formatTime(m.time)}] ${who}：${body}`;
      }).join('\n');
      const messages = [{ role: 'system', content: COMPRESS_PROMPT }, { role: 'user', content: '请压缩以下对话：\n\n' + transcript }];

      // 按 COMPRESS_CHAIN 的顺序试，前一个失败（或没给正文）就换下一个
      let summary = '';
      let used = null;
      for (const c of COMPRESS_CHAIN) {
        const option = findOption(c.model, c.group)?.option;
        if (!option?.ready) continue;
        try {
          summary = (await complete(option, messages, 4096)).text;
          if (summary) { used = option.model; break; }
        } catch (err) {
          log.error(`API compress ${option.model} failed:`, errorText(err));
        }
      }
      if (!summary) throw new Error('压缩用的模型都失败了');

      const first = toCompress[0];
      const last = toCompress[toCompress.length - 1];
      const { error } = await supabase.from('memories').insert({
        summary, session_id: 'cc', conversation_id: last.id, timestamp: new Date().toISOString(),
        metadata: { from_time: first.time, upto_time: last.time, count: toCompress.length, model: used },
      });
      if (error) throw new Error(error.message);
      log.log?.(`API compressed ${toCompress.length} messages with ${used}`);
    } finally {
      compressingNow = false;
    }
  }

  // 设置页"测试一下"：真发一句，看通不通、多快
  async function testModel(option) {
    const started = Date.now();
    try {
      const result = await complete(option, [{ role: 'user', content: '只回一个英文单词：pong' }], option.thinking ? 2048 : 64);
      return { ok: true, ms: Date.now() - started, text: result.text.slice(0, 200) };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: errorText(err) };
    }
  }

  return { enqueue, getBrain, bridgeFetch, resolveOption, testModel };
}

module.exports = { makeApiTurns, orderForModel, splitThinking };
