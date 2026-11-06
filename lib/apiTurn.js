// 沐 (CC) 聊天切到 API 时，后端替他回：从 bridge 拉上文 → 调中转站模型 → 把回复写回 bridge。
// 记录只有 bridge 那一份，所以聊天页、历史、SSE 都还是同一条线。接口约定见 docs/api-mode.md。
const OpenAI = require('openai');
const { DEFAULT_OPTION, COMPRESS_CHAIN, findOption, relayKeyFor, keyEnvName } = require('./apiModels');
const { fetchFileTypes } = require('./ccFiles');

const HISTORY_LIMIT = 200;           // 比压缩线大：话要么原文在上文里，要么已经进了会话摘要，不会两头都没有
const CONTEXT_TOKEN_BUDGET = 30000;  // 按 estimateTokens 估的，图片每张另算 IMAGE_TOKENS
const IMAGE_TOKENS = 1500;
const MAX_IMAGES = 4;                // 只给这一轮要回的消息里的图，最多几张
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // 上游按 base64 后算 5MB，原图得再小三成
const MAX_INLINE_FILE_BYTES = 64 * 1024;
const PERSONA_CACHE_MS = 5 * 60 * 1000;
const DIARY_MAX_CHARS = 2000;
const COMPRESS_HISTORY_LIMIT = 200;
const COMPRESS_MAX_FRESH = 120;      // 没到 token 阈值，条数到这里也压：短句聊满 100 多条时不能掉东西
const COMPRESS_KEEP_RAW = 60;
const SESSION_MAX_LAYERS = 3;        // 摘要最多压 3 层或满 24 小时，之后从原始聊天重新生成
const SESSION_MAX_AGE_MS = 24 * 3600 * 1000;
const REBUILD_MAX_PAGES = 10;
const COMPRESS_PROMPT = '你是一个记忆压缩助手。请将对话压缩成"本次会话摘要"，用第三人称描述。对话里"她"是桦桦，"沐"是她的伴侣。' +
  '必须保留：两人之间的梗和玩笑（写清楚梗是什么）、称呼、她刚纠正过的事（尽量用她的原话）、没做完的约定、她的情绪和身体状况。别的可以略。';

const API_NOTE = '\n\n【现在的情况】这会儿你是通过 API 在回她（VPS 上的 Claude Code 暂时没在接消息），这一轮你没有任何工具：' +
  '不能读写文件、不能跑命令、不能查东西，只能直接说话。别答应去做要用工具的事，真要做就说等回到 CC 再弄。' +
  '她每条消息前面的 [MM-DD HH:mm] 是她发消息的时间，你回复里不要写这种时间标记。';

// 有记忆包时加在它后面。这几句不变，缓存前缀就不变
const PACK_NOTE = '\n\n【这条线上的写法】她看不到下面这些标记，别解释它们：\n' +
  '- 她纠正你一件事，就在回复里写 <pin>她纠正的事</pin>，之后每轮都会带给你。\n' +
  '- 她要你到点叫她：写 [[闹钟:2026-11-07 08:00|起床]]，时间必须是绝对时间，到点会叫你说话并推送给她。\n' +
  '- 她最后一条消息后面的【现在】是后台附的，不是她说的，不用提它。';

const PRIVATE_MEMORY_RE = /^## intimacy-talk\.md\n[\s\S]*?(?=^## |^# |(?![\s\S]))/m;
const CONTENT_BLOCKED_RE = /违规|content.?(?:policy|filter)|moderation/i;

// 模型偶尔学着在开头写时间标记，回之前去掉
const LEADING_STAMP_RE = /^\s*\[(?:用户|助手|她|你)?\s*\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]\s*/;
// 有的渠道把思考过程直接写在正文开头
const THINK_BLOCK_RE = /^\s*<(think|thinking)>([\s\S]*?)<\/\1>\s*/;

const ROLES = new Set(['user', 'assistant']);
const hasSeq = (m) => Number.isSafeInteger(m.seq);

// 给模型看的先后：都有 seq 按 seq，否则按时间。API 回的那条挪到它 reply_to 那条后面
// （她在 API 回的时候又发了一条，bridge 给回复的 seq 会比那条大，不挪的话模型会以为那条已经回过了）
function orderForModel(messages) {
  // 作废的回复（她改了话、点了重新生成）留在 bridge 给前端折叠，模型不看，也不算"回过了"
  const list = messages.filter((m) => m && ROLES.has(m.role) && typeof m.id === 'string' && !m.superseded);
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

// 中转可能按 OpenAI 的写法（prompt_tokens_details.cached_tokens），也可能原样带 Anthropic 的字段
function usageView(u = {}) {
  return {
    prompt: u.prompt_tokens ?? u.input_tokens ?? null,
    cache_read: u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? 0,
    output: u.completion_tokens ?? u.output_tokens ?? null,
  };
}

function errorText(err) {
  return String(err?.message || err || 'unknown error').slice(0, 300);
}

function makeApiTurns({ bridgeConfig, supabase, voiceRule = '', formatTime, estimateTokens, onReply, env = process.env, log = console }) {
  const debounceMs = Number(env.API_TURN_DEBOUNCE_MS ?? 2500);
  const maxWaitMs = Number(env.API_TURN_MAX_WAIT_MS ?? 20000); // 她一直在打字也不能一直不回
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

  // 记忆包当缓存前缀：Claude 模型要明说 cache_control。中转不认（400）就记住，以后退回普通字符串（前缀不变，能自动缓存的渠道照样缓存）
  let cacheControlOk = env.API_PACK_CACHE_CONTROL !== '0';
  const systemMessage = (text, cached) => ({
    role: 'system',
    content: cached && cacheControlOk ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text,
  });

  async function completeWithSystem(option, system, cached, messages, maxTokens) {
    try {
      return await complete(option, [systemMessage(system, cached), ...messages], maxTokens);
    } catch (err) {
      if (!(cached && cacheControlOk && err?.status === 400)) throw err;
      cacheControlOk = false;
      return complete(option, [systemMessage(system, cached), ...messages], maxTokens);
    }
  }

  async function complete(option, messages, maxTokens) {
    const response = await clientFor(option.group).chat.completions.create({ model: option.model, max_tokens: maxTokens, messages });
    if (!response?.choices?.length) throw new Error(response?.error?.message || '中转站没有返回 choices');
    const msg = response.choices[0].message || {};
    if (response.usage) log.log?.('API usage', JSON.stringify(usageView(response.usage)));
    return { ...splitThinking(msg.content, msg.reasoning_content || msg.thinking), usage: response.usage };
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

  // 记忆包：bridge 没有（404、连不上）就退回下面的老拼法，别让这一轮回不上来
  async function bridgePack() {
    try {
      const r = await bridgeFetch('/pack');
      return r.ok && typeof r.data?.text === 'string' && r.data.text.trim() ? r.data.text : null;
    } catch (err) {
      log.error('API turn pack error:', err.message);
      return null;
    }
  }

  // 每轮都变的东西不进 system，挂在她最后一条后面：她在、钉子、今天的格子
  async function turnContext() {
    try {
      const r = await bridgeFetch('/turn-context');
      if (!r.ok) return { tail: '', notes: [] };
      const { capsule, health, pins, today, edit_notes: editNotes } = r.data || {};
      const lines = [capsule, health].filter(Boolean);
      if (Array.isArray(pins) && pins.length) lines.push(`钉住的事：\n${pins.map((p) => `- ${p}`).join('\n')}`);
      if (Array.isArray(today) && today.length) lines.push(`今天记下的：${today.map((i) => `${i.key}${i.value ? `：${i.value}` : ''}`).join('；')}`);
      return { tail: lines.length ? `\n\n【现在】\n${lines.join('\n')}` : '', notes: Array.isArray(editNotes) ? editNotes : [] };
    } catch (err) {
      log.error('API turn context error:', err.message);
      return { tail: '', notes: [] };
    }
  }

  async function buildSystem(settings) {
    const pack = await bridgePack();
    if (pack) return { system: pack + voiceRule + API_NOTE + PACK_NOTE, hasPack: true };
    return { system: await legacySystem(settings), hasPack: false };
  }

  async function legacySystem(settings) {
    const persona = (await bridgePersona()) || settings?.system_prompt || '你是沐，桦桦的伴侣。说话温柔自然，不端着。';
    const [{ data: memories }, { data: diaries }] = await Promise.all([
      supabase.from('memories').select('summary').order('timestamp', { ascending: false }).limit(10),
      supabase.from('diaries').select('content, diary_date, created_at').eq('author', 'mu').eq('visibility', 'public').order('created_at', { ascending: false }).limit(2),
    ]);
    let system = persona + voiceRule + API_NOTE;
    if (memories?.length) system += '\n\n【过往记忆】\n' + memories.map((m) => m.summary).join('\n---\n');
    // 封存的不给：这段要经中转发出去
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
    return { notes: [...notes, ...voiceNotes(m)], images };
  }

  // 语音：ears 转出来的字和语气就是全部内容（模型听不了录音），新旧消息都带上
  function voiceNotes(m) {
    return (Array.isArray(m.voices) ? m.voices : []).filter((v) => typeof v?.text === 'string' && v.text.trim()).map((v) => {
      const rel = v.relative && typeof v.relative === 'object' ? Object.entries(v.relative).map(([k, d]) => `${k}${d}`).join('、') : '';
      const tone = [v.emotion ? `语气：${v.emotion}${v.hint ? `——${v.hint}` : ''}` : '', rel ? `和她平时比：${rel}` : ''].filter(Boolean).join('；');
      return `[语音] 「${v.text.trim()}」${tone ? `（${tone}）` : ''}`;
    });
  }

  function plainMarkers(m) {
    const notes = [];
    if (Array.isArray(m.images) && m.images.length) notes.push(m.images.length > 1 ? `[${m.images.length} 张图片]` : '[图片]');
    for (const f of Array.isArray(m.files) ? m.files : []) notes.push(`[文件: ${typeof f?.name === 'string' ? f.name : '文件'}]`);
    return [...notes, ...voiceNotes(m)];
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

  // 什么时候开始这一轮：她最后一条、或者最后一次打字之后等满 debounce，但从第一条待回的算起不超过 maxWaitMs
  let firstPendingAt = 0;
  let lastComposingAt = 0;
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (running || !pending.size) return; // 正在回的这轮结束后会接着处理
    const at = Math.min(Math.max(lastEnqueueAt, lastComposingAt) + debounceMs, firstPendingAt + maxWaitMs);
    timer = setTimeout(drain, Math.max(0, at - Date.now()));
  }

  function enqueue(id) {
    if (typeof id !== 'string' || !id) return;
    if (!pending.size) firstPendingAt = Date.now();
    pending.add(id);
    lastEnqueueAt = Date.now();
    schedule();
  }

  // 前端：她的输入框有字、正在打（on=true，打字时约一秒一次）；清空了 on=false
  function composing(on) {
    lastComposingAt = on ? Date.now() : 0;
    schedule();
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
    schedule();
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
      const { system, hasPack } = await buildSystem(settings);
      const [{ tail, notes }, session] = hasPack ? await Promise.all([turnContext(), sessionSummary(brain)]) : [{ tail: '', notes: [] }, ''];
      const decorate = (msgs) => withSessionAndTail(msgs, session, tail, notes);

      let built = await buildMessages(context, answerIds, true);
      let result;
      try {
        result = await completeWithSystem(option, system, hasPack, decorate(built.messages), maxTokens);
      } catch (err) {
        if (hasPack && CONTENT_BLOCKED_RE.test(errorText(err))) {
          // 上游拦内容：最私密的那份拿掉再试一次，这一轮至少回得上
          log.error('API turn blocked, retrying without private memory');
          result = await completeWithSystem(option, system.replace(PRIVATE_MEMORY_RE, ''), hasPack, decorate(built.messages), maxTokens);
        } else {
          // 模型不收图（400）就去掉图再试一次
          if (!(built.hadImages && err?.status === 400)) throw err;
          built = await buildMessages(context, answerIds, false);
          result = await completeWithSystem(option, system, hasPack, decorate(built.messages), maxTokens);
        }
      }
      if (!result.text) throw new Error('模型没给正文');

      const turnId = `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const reply = { text: result.text, ...(result.thinking ? { thinking: result.thinking } : {}), model: option.model, group: option.group, reply_to: replyTo, turn_id: turnId, ...(notes.length ? { edit_notes_ack: notes.map((n) => n.id) } : {}) };
      let r;
      try {
        r = await bridgePost('/reply', reply);
      } catch {
        r = await bridgePost('/reply', reply); // 同一个 turn_id，bridge 不会存两条
      }
      if (!r.ok) throw new Error(`bridge reply ${r.status}`);
      if (r.data?.empty) return; // 只有标记没有话
      try { onReply?.(r.data?.id || turnId, r.data?.text || result.text); } catch (e) { log.error('API turn onReply error:', e.message); }
      maybeCompress(settings).catch((e) => log.error('API compress error:', e.message));
    } catch (err) {
      await reportFailure(replyTo, err);
    }
  }

  // 会话摘要放在最前，她最后一条挂【现在】。都不动 system，缓存前缀不变
  function withSessionAndTail(messages, session, tail, notes = []) {
    const out = messages.map((m) => ({ ...m }));
    const add = (m, fn) => {
      if (typeof m.content === 'string') m.content = fn(m.content);
      else m.content = m.content.map((p) => (p.type === 'text' ? { ...p, text: fn(p.text) } : p));
    };
    if (session && out.length) add(out[0], (t) => `【本次会话摘要，更早的话在这里】\n${session}\n【摘要完】\n\n${t}`);
    const edited = notes.length ? `[系统说明，不是她这次说的：${notes.map((n) => n.line).join('；')}]\n` : '';
    if ((tail || edited) && out.length) add(out[out.length - 1], (t) => edited + t + tail);
    return out;
  }

  // 这次切到 API 以来的摘要行，旧的在前。重新生成过的那行之前的都作废
  async function sessionRows(brain) {
    const since = Date.parse(brain?.switched_at) || 0;
    const { data } = await supabase.from('memories').select('summary, metadata, created_at').eq('session_id', 'cc').order('created_at', { ascending: true }).limit(200);
    const rows = (data || []).filter((m) => Date.parse(m.metadata?.upto_time) > since);
    const lastRebuilt = rows.map((m) => !!m.metadata?.rebuilt).lastIndexOf(true);
    return lastRebuilt < 0 ? rows : rows.slice(lastRebuilt);
  }

  async function sessionSummary(brain) {
    try {
      return (await sessionRows(brain)).map((m) => m.summary).join('\n---\n');
    } catch (err) {
      log.error('API session summary error:', err.message);
      return '';
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
        .filter((m) => Date.parse(m.time) > upto && (typeof m.text === 'string' && m.text.trim() || m.images?.length || m.files?.length || m.voices?.length));
      const tokens = fresh.reduce((n, m) => n + estimateTokens(m.text || ''), 0);
      const byCount = fresh.length > COMPRESS_MAX_FRESH;
      if (!byCount && (tokens < threshold || fresh.length <= keepCount)) return;

      const keep = byCount ? Math.min(keepCount, COMPRESS_KEEP_RAW) : keepCount;
      const toCompress = fresh.slice(0, fresh.length - keep);
      const brain = await getBrain().catch(() => null);
      const rows = await sessionRows(brain);
      const stale = rows.length >= SESSION_MAX_LAYERS || (rows.length && Date.now() - Date.parse(rows[0].created_at) >= SESSION_MAX_AGE_MS);
      if (stale) await writeSummary(await rawSince(brain, toCompress), true);
      else await writeSummary(toCompress, false);
    } finally {
      compressingNow = false;
    }
  }

  async function writeSummary(list, rebuilt) {
    const transcript = list.map((m) => {
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

    const first = list[0];
    const last = list[list.length - 1];
    const { error } = await supabase.from('memories').insert({
      summary, session_id: 'cc', conversation_id: last.id, timestamp: new Date().toISOString(),
      metadata: { from_time: first.time, upto_time: last.time, count: list.length, model: used, ...(rebuilt ? { rebuilt: true } : {}) },
    });
    if (error) throw new Error(error.message);
    log.log?.(`API compressed ${list.length} messages with ${used}${rebuilt ? ' (rebuilt from raw)' : ''}`);
  }

  // 重新生成用的原文：从这次切过来起，到 toCompress 的最后一条。不是摘要的摘要
  async function rawSince(brain, toCompress) {
    const since = Date.parse(brain?.switched_at) || 0;
    const uptoMs = Date.parse(toCompress[toCompress.length - 1].time);
    const seen = new Map();
    let before = null;
    for (let i = 0; i < REBUILD_MAX_PAGES; i++) {
      const r = await bridgeFetch(`/history?limit=${COMPRESS_HISTORY_LIMIT}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (!r.ok) throw new Error(`bridge history ${r.status}`);
      const page = r.data?.messages || [];
      if (!page.length) break;
      for (const m of page) seen.set(m.id, m);
      before = page.reduce((a, m) => (!a || Date.parse(m.time) < Date.parse(a) ? m.time : a), null);
      if (Date.parse(before) <= since) break;
    }
    return orderForModel([...seen.values()])
      .filter((m) => Date.parse(m.time) > since && Date.parse(m.time) <= uptoMs && (typeof m.text === 'string' && m.text.trim() || m.images?.length || m.files?.length || m.voices?.length));
  }

  // 中转到底缓不缓存：同一份记忆包连发两次，看第二次 usage 里的 cache_read。真花钱，只手动跑
  async function cacheProbe() {
    const brain = await getBrain();
    const option = resolveOption(brain)?.option;
    const pack = await bridgePack();
    if (!option || !pack) throw new Error(!option ? '没有可用的模型' : 'bridge 还没有记忆包');
    const ask = [{ role: 'user', content: '只回一个英文单词：pong' }];
    const call = async () => usageView((await completeWithSystem(option, pack, true, ask, option.thinking ? 2048 : 64)).usage || {});
    const first = await call();
    await new Promise((r) => setTimeout(r, Number(env.API_CACHE_PROBE_WAIT_MS ?? 3000)));
    const second = await call();
    return { model: option.model, cache_control_sent: cacheControlOk, first, second, cached: second.cache_read > 0 };
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

  return { enqueue, composing, getBrain, bridgeFetch, resolveOption, testModel, cacheProbe };
}

module.exports = { makeApiTurns, orderForModel, splitThinking };
