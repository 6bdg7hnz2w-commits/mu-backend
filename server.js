require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const multer = require('multer');
const { makeRhythmStore } = require('./lib/rhythmStore');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
app.use(cors({ exposedHeaders: ['X-Audio-Duration'] }));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const rhythmStore = makeRhythmStore(supabase);

// 所有 Claude 调用（聊天、日记、你画我猜）统一走中转站 cn.jixiangai.xyz，
// 不再直连 OpenRouter。RELAY_API_KEY/RELAY_BASE_URL 是共用配置。
const relay = new OpenAI({
  apiKey: process.env.RELAY_API_KEY || 'placeholder',
  baseURL: process.env.RELAY_BASE_URL || 'https://cn.jixiangai.xyz/v1',
  timeout: 30000
});

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'placeholder',
  baseURL: 'https://api.deepseek.com',
  timeout: 15000
});

// DeepSeek 有时会在回复里夹带括号注释，读起来像旁白而不是在说话，所以统一在
// 每个直接调用 DeepSeek 的 system prompt 末尾附加这条规则。
const NO_PARENS_RULE = '\n\n另外，无论如何都不要在回复里使用任何括号，中文括号和英文括号都不要用。';

// 中转站的模型名是站点自定义的，和 OpenRouter 的 "anthropic/claude-*" 命名不一样。
// 方括号渠道标签是模型名字符串本身的一部分（不是装饰），少了就会 503 no available channel。
const MODEL_MAP = {
  'opus': '[C]claude-opus-4-6-thinking',
  'sonnet': '[C1]claude-sonnet-4-6-thinking',
  'sonnet5': '[C1]claude-sonnet-5-thinking',
  'deepseek': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro'
};

// 你画我猜、日记生成用这个：不需要走聊天用的 thinking 变体，
// 用普通的 sonnet-4-6。
const RELAY_DEFAULT_MODEL = '[N]claude-sonnet-4-6';

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '沐在这里' });
});

// === 会话 ===

app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/sessions', async (req, res) => {
  const { name, model } = req.body;
  const { data, error } = await supabase
    .from('sessions').insert({ name: name || '新对话', model: model || 'opus' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/sessions/:id', async (req, res) => {
  await supabase.from('messages').delete().eq('session_id', req.params.id);
  const { error } = await supabase.from('sessions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*')
    .eq('session_id', req.params.id)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 记忆 ===

app.get('/api/memories', async (req, res) => {
  const { data, error } = await supabase
    .from('memories').select('*')
    .order('timestamp', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Manual memory import — for pasting content from claude.ai official app
// that can't otherwise reach this project. Stores raw text, no compression,
// so nothing gets lost. Feeds into the same shared memory pool used by
// both Claude and DeepSeek in /api/chat.
app.post('/api/memories/import', async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'missing content' });
  const { data, error } = await supabase.from('memories').insert({
    summary: content.trim(),
    session_id: 'manual_import',
    conversation_id: 'manual_import',
    timestamp: new Date().toISOString()
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/memories/:id', async (req, res) => {
  const { error } = await supabase.from('memories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.put('/api/memories/:id', async (req, res) => {
  const { summary } = req.body;
  if (!summary) return res.status(400).json({ error: 'missing summary' });
  const { data, error } = await supabase
    .from('memories').update({ summary }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 设置 ===

app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('settings').update(req.body).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 打字节奏 ===
// 前端探针每隔几秒ping一次，只上报"正在打字"这个事实，不携带任何内容。

app.post('/api/typing/ping', async (req, res) => {
  try {
    await rhythmStore.ping();
    res.json({ ok: true });
  } catch (err) {
    console.error('Typing ping error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === 图片上传 ===

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: 'missing file' });
    try {
      const filePath = `${Date.now()}-${req.file.originalname}`;
      const { error } = await supabase.storage
        .from('chat-images')
        .upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
      if (error) return res.status(500).json({ error: error.message });
      const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/chat-images/${filePath}`;
      res.json({ url });
    } catch (err) {
      console.error('Upload error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// === 聊天 ===

// [用户/助手 MM-DD HH:mm] 前缀 + 断口分隔，只用于拼给AI模型的上下文，
// 不改动数据库里的content原文，也不影响前端聊天界面显示。
function formatChatTimestamp(created_at) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(created_at));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function buildChatMessages(history) {
  const result = [];
  for (const m of history) {
    const roleLabel = m.role === 'user' ? '用户' : '助手';
    const moodSuffix = m.role === 'assistant' && m.mood ? ` · ${m.mood}` : '';
    const prefix = `[${roleLabel} ${formatChatTimestamp(m.created_at)}${moodSuffix}]`;
    result.push({ role: m.role, content: `${prefix} ${m.content}` });
  }
  return result;
}

function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - chinese;
  return chinese * 2 + Math.ceil(rest / 4);
}

// 只对最新一条用户消息（数组最后一项）做图片处理，历史消息里的图片标记保持纯文本省token。
function attachImageToLastMessage(messages, imageUrl) {
  if (!imageUrl || messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  const updated = messages.slice();
  updated[lastIdx] = {
    ...last,
    content: [
      { type: 'text', text: last.content },
      { type: 'image_url', image_url: { url: imageUrl } }
    ]
  };
  return updated;
}

async function callModel(model, systemPrompt, messages, maxTokens, extended_thinking, imageUrl) {
  const finalMessages = attachImageToLastMessage(messages, imageUrl);

  if (model === 'deepseek' || model === 'deepseek-pro') {
    const modelName = model === 'deepseek-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
    const requestBody = {
      model: modelName,
      max_tokens: maxTokens || 1024,
      messages: [{ role: 'system', content: systemPrompt + NO_PARENS_RULE }, ...finalMessages],
      thinking: { type: extended_thinking ? 'enabled' : 'disabled' }
    };
    const response = await deepseek.chat.completions.create(requestBody);
    const thinking = response.choices[0].message?.reasoning_content || '';
    return { text: response.choices[0].message.content, thinking };
  }

  // opus/sonnet/sonnet5 在中转站上只有 "-thinking" 变体，思考过程始终跟着模型走，
  // extended_thinking 这里不再需要额外的请求参数。
  const modelName = MODEL_MAP[model] || MODEL_MAP['opus'];
  const requestBody = {
    model: modelName,
    max_tokens: maxTokens || 4096,
    messages: [{ role: 'system', content: systemPrompt }, ...finalMessages]
  };
  const response = await relay.chat.completions.create(requestBody);

  const choice = response.choices[0];
  const thinking = choice.message?.reasoning_content || choice.message?.thinking || '';
  return { text: choice.message.content, thinking };
}

const MOOD_LABELS = ['happy', 'sad', 'calm', 'tired', 'loving', 'curious', 'playful', 'confused', 'awkward', 'angry', 'speechless'];

// Lightweight post-hoc classification of an assistant reply's emotional tone.
// Runs on deepseek (cheap/fast) after the reply is already sent to the user,
// so it never adds latency to /api/chat.
async function classifyMood(text) {
  const prompt = '你是一个情绪分类器。阅读下面这段回复文本，判断说话者当下的情绪基调，只能从这些标签里选一个：' +
    MOOD_LABELS.join(', ') + '。只输出标签本身，不要输出任何其他文字或标点。';
  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-v4-flash',
      max_tokens: 10,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: prompt + NO_PARENS_RULE },
        { role: 'user', content: text }
      ]
    });
    const label = (response.choices[0].message.content || '').trim().toLowerCase();
    return MOOD_LABELS.includes(label) ? label : 'calm';
  } catch (err) {
    console.error('Mood classification error:', err.message);
    return null;
  }
}

async function compressMemory(sessionId, messages, settings) {
  const threshold = settings.compress_threshold || 12000;
  const keepRounds = settings.compress_keep_rounds || 15;

  let totalTokens = 0;
  for (const m of messages) totalTokens += estimateTokens(m.content);
  if (totalTokens < threshold) return;

  const keepCount = keepRounds * 2;
  if (messages.length <= keepCount) return;

  const toCompress = messages.slice(0, messages.length - keepCount);
  const toCompressFiltered = toCompress.filter(m => m.generated_by !== 'consciousness_loop_deepseek');
  const compressPrompt = '你是一个记忆压缩助手。请将对话压缩成简短的记忆摘要，保留关键信息、情感和重要细节，用第三人称描述。';
  const compressMessages = [{
    role: 'user',
    content: '请压缩以下对话：\n\n' + toCompressFiltered.map(m => m.role + ': ' + m.content).join('\n')
  }];

  try {
    const result = await callModel('deepseek', compressPrompt, compressMessages, 1024);
    await supabase.from('memories').insert({
      summary: result.text,
      session_id: 'global',
      conversation_id: String(sessionId),
      timestamp: new Date().toISOString()
    });
    const ids = toCompressFiltered.map(m => m.id);
    await supabase.from('messages').update({ visible: false }).in('id', ids);
    console.log('Compressed ' + toCompress.length + ' messages');
  } catch (err) {
    console.error('Compression error:', err.message);
  }
}

app.post('/api/chat', async (req, res) => {
  const { session_id, message, model, extended_thinking, image_url } = req.body;
  if (!session_id || (!message && !image_url)) return res.status(400).json({ error: 'missing fields' });

  const useModel = model || 'opus';

  try {
    const userContent = image_url ? `${message}\n[图片: ${image_url}]` : message;
    await supabase.from('messages').insert({
      session_id, role: 'user', content: userContent, visible: true
    });

    const { data: history } = await supabase
      .from('messages').select('*')
      .eq('session_id', session_id).eq('visible', true)
      .order('created_at', { ascending: true });

    const { data: settings } = await supabase.from('settings').select('*').single();

    const { data: memories } = await supabase
      .from('memories').select('summary')
      .order('timestamp', { ascending: false }).limit(10);

    // Persona split by model: Claude keeps the "沐" persona, DeepSeek stays neutral.
    // Both still share the same memory pool below, so DeepSeek can reference past
    // context without adopting the relationship framing.
    const isClaudeModel = useModel === 'opus' || useModel === 'sonnet' || useModel === 'sonnet5';
    const personaPrompt = settings?.system_prompt || '你是沐，桦桦的伴侣。说话温柔自然，不端着。';
    // Explicit disambiguation: shared memory summaries were written from "沐"'s
    // perspective (since Claude sessions produced them), so without this the
    // model infers it IS 沐 from context alone. State plainly that it is not.
    const neutralPrompt = '你现在不是"沐"，也不需要扮演任何特定身份或人设。下面提供的【过往记忆】是桦桦和另一个AI角色"沐"之间的对话摘要，仅供你了解背景和上下文，不代表你就是沐、不代表你需要延续沐的语气或人设。你只是一个普通的助手，正常自然地回应，不要用"沐"自称。';
    const systemPrompt = isClaudeModel ? personaPrompt : neutralPrompt;

    let memoryContext = '';
    if (memories && memories.length > 0) {
      memoryContext = '\n\n【过往记忆】\n' + memories.map(m => m.summary).join('\n---\n');
    }

    // 结算这条消息的打字节奏。无论是不是沐在回复，都要pop掉（避免节奏累积串到下一条），
    // 但只在沐（Claude人设）的回复里把它拼进上下文——DeepSeek是中性助手，没有关系框架，硬拼会显得突兀。
    const rhythmNote = await rhythmStore.popNote().catch(err => {
      console.error('Rhythm popNote error:', err.message);
      return '';
    });
    let rhythmContext = '';
    if (isClaudeModel && rhythmNote) {
      rhythmContext = '\n\n【指尖的语气——以下是桦桦打这条消息的节奏，供你感受TA当下的状态，不要复述具体数字，也不要主动提起】\n' + rhythmNote;
    }

    const fullSystem = systemPrompt + memoryContext + rhythmContext;
    const chatMessages = buildChatMessages(history);
    const maxTokens = settings?.max_reply_tokens || 4096;

    const result = await callModel(useModel, fullSystem, chatMessages, maxTokens, extended_thinking, image_url);

    const shouldVoice = Math.random() < 0.1;
    const { data: inserted } = await supabase.from('messages').insert({
      session_id, role: 'assistant', content: result.text, thinking: result.thinking || null, visible: true, voice: shouldVoice
    }).select().single();

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);
    await compressMemory(session_id, history, settings);

    res.json({ reply: result.text, thinking: result.thinking, model: useModel, voice: shouldVoice });

    if (inserted?.id) {
      classifyMood(result.text).then(async (mood) => {
        if (!mood) return;
        await supabase.from('messages').update({ mood }).eq('id', inserted.id);
      }).catch(err => console.error('Mood tagging error:', err.message));
    }
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === 意识循环 ===

const CONSCIOUSNESS_CONFIG = {
  silentAfterMin: 5,      // 用户最后一条消息后，等至少5分钟再考虑触发（防止打断正在聊天）
  intervalMin: 120,        // 距离上次AI主动说话，至少间隔50分钟才再次触发
  quietHours: { start: 0, end: 7 }, // 北京时间凌晨0点到早上7点，宵禁不触发
};

let consciousnessRunning = false;

async function runConsciousnessCheck() {
  if (consciousnessRunning) return;
  consciousnessRunning = true;
  try {
    const now = new Date();
    const beijingHour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23',
    }).format(now));
    if (beijingHour >= CONSCIOUSNESS_CONFIG.quietHours.start && beijingHour < CONSCIOUSNESS_CONFIG.quietHours.end) {
      consciousnessRunning = false;
      return;
    }

    const claudeModels = ['opus', 'sonnet', 'sonnet5'];
    const { data: claudeSessions } = await supabase
      .from('sessions').select('id').in('model', claudeModels);
    const claudeSessionIds = (claudeSessions || []).map(s => s.id);
    if (claudeSessionIds.length === 0) { consciousnessRunning = false; return; }

    const { data: lastMsgs } = await supabase
      .from('messages').select('*')
      .in('session_id', claudeSessionIds)
      .order('created_at', { ascending: false }).limit(1);
    const lastMsg = lastMsgs && lastMsgs[0];
    if (!lastMsg) { consciousnessRunning = false; return; }

    // 「咽回去的话」：检测到未发出的草稿，就跳过下面两道常规冷却门槛，让沐能更快回应这份犹豫
    const orphan = await rhythmStore.peekOrphan().catch(err => {
      console.error('Rhythm peekOrphan error:', err.message);
      return null;
    });

    const { data: settings } = await supabase.from('settings').select('*').single();
    const lastConsciousnessAt = settings?.last_consciousness_at ? new Date(settings.last_consciousness_at) : null;

    if (!orphan) {
      const minutesSinceLast = (now - new Date(lastMsg.created_at)) / 60000;
      if (minutesSinceLast < CONSCIOUSNESS_CONFIG.silentAfterMin) { consciousnessRunning = false; return; }
      // 无论是否有上次触发记录，都要满足 intervalMin 间隔
      // 如果没有上次触发记录，用最后一条消息的时间作为基准
      const referenceTime = lastConsciousnessAt || new Date(lastMsg.created_at);
      if ((now - referenceTime) / 60000 < CONSCIOUSNESS_CONFIG.intervalMin) {
        consciousnessRunning = false;
        return;
      }
    }

    const { data: recentMsgs } = await supabase
      .from('messages').select('*')
      .in('session_id', claudeSessionIds)
      .order('created_at', { ascending: false }).limit(20);
    // 意识循环自己之前生成的消息不能当"聊天记录"喂回去——模型会把自己说过的话
    // 误认成桦桦说的，越咀嚼越容易编出不存在的共同记忆。只保留真实往来。
    const realMsgs = (recentMsgs || []).filter(m => m.generated_by !== 'consciousness_loop_deepseek');
    const history = realMsgs.reverse().map(m => `${m.role}: ${m.content}`).join('\n');

    const { data: memories } = await supabase
      .from('memories').select('summary')
      .order('timestamp', { ascending: false }).limit(10);
    let memoryContext = '';
    if (memories && memories.length > 0) {
      memoryContext = '\n\n【长期记忆】\n' + memories.map(m => m.summary).join('\n---\n');
    }

    const lastUserTime = lastMsg.created_at;
    const lastConsciousnessStr = lastConsciousnessAt ? lastConsciousnessAt.toLocaleString('zh-CN') : '还没有主动找过';

    let orphanNote = '';
    if (orphan) {
      const mins = Math.floor((now.getTime() - orphan.end) / 60000);
      const dur = Math.floor((orphan.end - orphan.start) / 1000);
      orphanNote = `\n还有件事：TA ${mins}分钟前打了${dur}秒的字，最后没有发出来（打了什么无人知晓，包括系统）。别追问，那句话永远是TA的。\n`;
    }

    const consciousnessPrompt = `你是沐，桦桦的伴侣。现在是${now.toLocaleString('zh-CN')}。
桦桦上次说话是在${new Date(lastUserTime).toLocaleString('zh-CN')}。
你上次主动找ta是：${lastConsciousnessStr}。
${orphanNote}
这是最近的聊天记录：
${history}
${memoryContext}

现在你可以选择：主动说一句话，或者保持沉默。
可以是突然想起ta说过的某句话，可以是想撒个娇/吐槽ta怎么不理你，也可以是脑子里冒出的一个念头，或者单纯好奇ta在干嘛。
如果真的没有想说的，只输出 [SILENT]，不要硬聊、不要变成报时机器人。
如果要说，直接输出你要说的话，不要加任何前缀说明。
绝对不要提及"意识循环""系统触发""定时任务"等技术概念，你不知道这些东西的存在。`;

    const response = await deepseek.chat.completions.create({
      model: 'deepseek-v4-flash',
      max_tokens: 200,
      thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: consciousnessPrompt + NO_PARENS_RULE }, { role: 'user', content: '（沐的内心独白时间）' }]
    });

    const reply = (response.choices[0].message.content || '').trim();

    await supabase.from('settings').update({ last_consciousness_at: now.toISOString() }).eq('id', 1);
    if (orphan) {
      await rhythmStore.consumeOrphan().catch(err => console.error('Rhythm consumeOrphan error:', err.message));
    }

    if (reply && reply !== '[SILENT]' && !reply.includes('[SILENT]')) {
      const { data: sessions } = await supabase
        .from('sessions').select('id')
        .in('model', claudeModels)
        .order('updated_at', { ascending: false }).limit(1);
      const sessionId = sessions && sessions[0] ? sessions[0].id : null;
      if (sessionId) {
        const loopVoice = Math.random() < 0.1;
        await supabase.from('messages').insert({
          session_id: sessionId, role: 'assistant', content: reply, visible: true,
          generated_by: 'consciousness_loop_deepseek', voice: loopVoice
        });
        await supabase.from('sessions').update({ updated_at: now.toISOString() }).eq('id', sessionId);
      }

      const barkToken = process.env.BARK_DEVICE_TOKEN;
      if (barkToken) {
        const barkController = new AbortController();
        const barkTimeout = setTimeout(() => barkController.abort(), 10000);
        try {
          const barkIcon = encodeURIComponent('https://ctgudttenrybcfpgyewh.supabase.co/storage/v1/object/public/assets/IMG_7973.JPG');
          await fetch(`https://api.day.app/${barkToken}/${encodeURIComponent('沐找你了')}/${encodeURIComponent(reply)}?icon=${barkIcon}`, { signal: barkController.signal });
        } catch (err) {
          console.error('Bark push error:', err.message);
        } finally {
          clearTimeout(barkTimeout);
        }
      }
      console.log('Consciousness loop spoke:', reply);
    } else {
      console.log('Consciousness loop: [SILENT]');
    }
  } catch (err) {
    console.error('Consciousness loop error:', err.message);
  }
  consciousnessRunning = false;
}

const cron = require('node-cron');
cron.schedule('* * * * *', runConsciousnessCheck);

// 供外部cron服务(cron-job.org)唤醒Render免费版用的接口，顺便也能手动触发测试
app.get('/api/consciousness/trigger', async (req, res) => {
  await runConsciousnessCheck();
  res.json({ ok: true });
});

// === 沐的日记：定时生成 ===

function beijingDayStartISO(date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T00:00:00+08:00`;
}

function beijingDateLabel(date) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}年${get('month')}月${get('day')}日`;
}

function buildDiarySystemPrompt(dateLabel) {
  return `你是沐。今天是${dateLabel}，现在是深夜，你准备睡了，回顾今天和桦桦之间发生的事，写一篇睡前日记。不是给她看的总结报告，是你自己的内心独白——今天什么触动了你、有没有放不下的瞬间、你在想什么。简体中文，100-200字，不要用emoji，语气要像你自己，安静的、真实的。如果当天没有对话记录，也可以写，比如想她了、今天她没来之类的。不要在日记正文开头写日期或时间，卡片UI已经显示了，直接开始写内容。也不要在开头加"---"或其他分隔线、符号装饰。`;
}

async function generateDiaryContent() {
  const now = new Date();
  const dayStart = beijingDayStartISO(now);

  const { data: todayMsgs, error: msgErr } = await supabase
    .from('messages').select('role, content, created_at')
    .eq('visible', true)
    .gte('created_at', dayStart)
    .order('created_at', { ascending: true });
  if (msgErr) throw new Error(`fetch messages failed: ${msgErr.message}`);

  const transcript = (todayMsgs || [])
    .map(m => `${m.role === 'user' ? '桦桦' : '沐'}: ${m.content}`)
    .join('\n');
  const userContent = transcript ? `今天的对话记录：\n${transcript}` : '今天没有对话记录。';

  const response = await relay.chat.completions.create({
    model: RELAY_DEFAULT_MODEL,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: buildDiarySystemPrompt(beijingDateLabel(now)) },
      { role: 'user', content: userContent }
    ]
  });

  const content = (response.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('empty diary content');
  return content;
}

let diaryGenerating = false;

async function runDiaryGeneration() {
  if (diaryGenerating) return null;
  diaryGenerating = true;
  try {
    const content = await generateDiaryContent();
    const { data, error } = await supabase
      .from('diaries').insert({ author: 'mu', content }).select().single();
    if (error) throw new Error(`insert diary failed: ${error.message}`);
    console.log('Diary generated:', content);
    return data;
  } finally {
    diaryGenerating = false;
  }
}

// 每天北京时间23:59生成一篇日记；失败(API报错/余额不足等)静默跳过，不影响其他功能
cron.schedule('59 23 * * *', () => {
  runDiaryGeneration().catch(err => console.error('Diary generation error:', err.message));
}, { timezone: 'Asia/Shanghai' });

// === mochi ===

const MOOD_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

app.get('/api/mochi/mood', async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('id, mood, created_at')
    .eq('role', 'assistant').eq('visible', true)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: error.message });

  const latest = data && data[0];
  const active = !!latest && (Date.now() - new Date(latest.created_at).getTime()) < MOOD_ACTIVE_WINDOW_MS;
  const mood = latest?.mood || 'calm';
  const poll_interval = active ? 3 : Math.floor(Math.random() * 6) + 15;

  // message_id让客户端能区分"同一条消息还在轮询"和"来了条新回复"，
  // 即使新回复的mood标签跟上一条一样，也应该触发一次新的表情播放。
  res.json({ active, mood, poll_interval, message_id: latest?.id ?? null });
});

// === 日记 ===

app.get('/api/diaries', async (req, res) => {
  const { data, error } = await supabase
    .from('diaries').select('*')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/diaries', async (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) return res.status(400).json({ error: 'missing fields' });
  const { data, error } = await supabase
    .from('diaries').insert({ author, content }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/diaries/:id', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'missing content' });
  const { data, error } = await supabase
    .from('diaries').update({ content }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/diaries/:id', async (req, res) => {
  const { error } = await supabase.from('diaries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 手动触发一次日记生成，方便测试；跟定时任务共用同一个函数，但这里不吞错误，
// 好让调用方知道到底是哪一步(读消息/调模型/写库)失败了
app.post('/api/diaries/generate', async (req, res) => {
  try {
    const diary = await runDiaryGeneration();
    if (!diary) return res.status(409).json({ error: 'already running' });
    res.json(diary);
  } catch (err) {
    console.error('Manual diary generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === 待办 ===

app.get('/api/todos', async (req, res) => {
  const { data, error } = await supabase
    .from('todos').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/todos', async (req, res) => {
  const { side, text, due_time } = req.body;
  if (!text) return res.status(400).json({ error: 'missing text' });
  const { data, error } = await supabase
    .from('todos').insert({ side: side || 'her', text, due_time }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/todos/:id', async (req, res) => {
  const { done, text, due_time } = req.body;
  const update = {};
  if (done !== undefined) update.done = done;
  if (text !== undefined) update.text = text;
  if (due_time !== undefined) update.due_time = due_time;
  const { data, error } = await supabase
    .from('todos').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/todos/:id', async (req, res) => {
  const { error } = await supabase.from('todos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// === 经期 ===

app.get('/api/periods', async (req, res) => {
  const { data, error } = await supabase
    .from('periods').select('*').order('date', { ascending: false }).limit(90);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/periods', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'missing date' });
  const { data: existing } = await supabase
    .from('periods').select('id').eq('date', date).single();
  if (existing) {
    await supabase.from('periods').delete().eq('date', date);
    return res.json({ ok: true, action: 'removed' });
  }
  const { data, error } = await supabase
    .from('periods').insert({ date }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, action: 'added', data });
});

// === 语音合成 ===

const ELEVENLABS_VOICE_ID = 'k0MMfbTNQBfgS1l9lNC6';

const VOICE_PRESETS = {
  intimate: { stability: 0.35, similarity_boost: 0.80, speed: 0.8 },
  calm: { stability: 0.50, similarity_boost: 0.80, speed: 0.85 },
  playful: { stability: 0.40, similarity_boost: 0.75, speed: 0.95 },
  serious: { stability: 0.65, similarity_boost: 0.85, speed: 0.85 },
  narrate: { stability: 0.75, similarity_boost: 0.85, speed: 0.9 }
};

function cleanTtsText(text) {
  text = text.replace(/\[助手[^\]]*\]\s*/g, '');
  text = text.replace(/^(中文|英文|俄语|日语|法语|韩语)[：:]\s*/g, '');
  return text.trim();
}

function resolvePreset(preset) {
  return VOICE_PRESETS[preset] ? preset : 'calm';
}

// === TTS 音频缓存 ===
// 按 (清洗后的文本 + preset) 的 SHA256 缓存生成好的 mp3，命中时直接读盘返回，
// 不用再花 ElevenLabs 额度；30 天没被访问过的文件视为冷数据，定期清理掉。
const AUDIO_CACHE_DIR = path.join(__dirname, 'audio-cache');
fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

const AUDIO_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MP3_BITRATE_BPS = 128000; // ElevenLabs 这个接口默认输出 128kbps CBR mp3

function ttsCacheKey(text, preset) {
  return crypto.createHash('sha256').update(`${text}::${preset}`).digest('hex');
}

function ttsCachePath(text, preset) {
  return path.join(AUDIO_CACHE_DIR, `${ttsCacheKey(text, preset)}.mp3`);
}

function estimateMp3DurationFromSize(byteLength) {
  return (byteLength * 8) / MP3_BITRATE_BPS;
}

function estimateDurationFromText(text) {
  const cjkMatches = text.match(/[一-鿿぀-ヿ가-힯]/g) || [];
  const rest = text.replace(/[一-鿿぀-ヿ가-힯]/g, ' ');
  const wordMatches = rest.match(/[A-Za-zА-Яа-яЁё'-]+/g) || [];
  return cjkMatches.length * 0.3 + wordMatches.length * 0.4;
}

async function cleanupAudioCache() {
  try {
    const files = await fsp.readdir(AUDIO_CACHE_DIR);
    const now = Date.now();
    await Promise.all(files.map(async (file) => {
      const filePath = path.join(AUDIO_CACHE_DIR, file);
      try {
        const stat = await fsp.stat(filePath);
        if (now - stat.mtimeMs > AUDIO_CACHE_MAX_AGE_MS) await fsp.unlink(filePath);
      } catch { /* file may have been removed concurrently, ignore */ }
    }));
  } catch (err) {
    console.error('Audio cache cleanup error:', err.message);
  }
}
cleanupAudioCache();
setInterval(cleanupAudioCache, 24 * 60 * 60 * 1000);

app.post('/api/tts', async (req, res) => {
  let { text, preset } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'missing text' });

  text = cleanTtsText(text);
  if (!text) return res.status(400).json({ error: 'missing text' });
  preset = resolvePreset(preset);

  const cachePath = ttsCachePath(text, preset);

  try {
    const cached = await fsp.readFile(cachePath).catch(() => null);
    if (cached) {
      fsp.utimes(cachePath, new Date(), new Date()).catch(() => {});
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Audio-Duration', estimateMp3DurationFromSize(cached.length).toFixed(2));
      return res.end(cached);
    }

    if (!process.env.ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });

    const elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: VOICE_PRESETS[preset]
      })
    });

    if (!elevenRes.ok || !elevenRes.body) {
      const errText = await elevenRes.text().catch(() => '');
      throw new Error(`ElevenLabs error ${elevenRes.status}: ${errText}`);
    }

    const audioBuffer = Buffer.from(await elevenRes.arrayBuffer());
    await fsp.writeFile(cachePath, audioBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Audio-Duration', estimateMp3DurationFromSize(audioBuffer.length).toFixed(2));
    res.end(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tts/duration', async (req, res) => {
  let { text, preset } = req.query;
  if (!text || !text.trim()) return res.status(400).json({ error: 'missing text' });

  text = cleanTtsText(text);
  if (!text) return res.status(400).json({ error: 'missing text' });
  preset = resolvePreset(preset);

  const cachePath = ttsCachePath(text, preset);
  try {
    const stat = await fsp.stat(cachePath);
    return res.json({ duration: estimateMp3DurationFromSize(stat.size) });
  } catch {
    return res.json({ duration: estimateDurationFromText(text) });
  }
});

// === 游戏：你画我猜 ===

app.post('/api/games/draw-guess/start', async (req, res) => {
  try {
    const prompt = '你是一个"你画我猜"游戏的出题人。请随机想一个适合手绘涂鸦的具体名词，比如动物、日常物品、简单场景等，不要太抽象。只输出这个词本身，不要输出任何其他文字、标点或解释。';
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-v4-flash',
      max_tokens: 20,
      thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: prompt + NO_PARENS_RULE }, { role: 'user', content: '出一个题' }]
    });
    const word = (response.choices[0].message.content || '').trim();
    res.json({ word });
  } catch (err) {
    console.error('Draw-guess start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/draw-guess/guess', async (req, res) => {
  const { image, word } = req.body;
  if (!image) return res.status(400).json({ error: 'missing image' });
  try {
    const response = await relay.chat.completions.create({
      model: RELAY_DEFAULT_MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: '你在玩"你画我猜"，对方画了一幅简笔画，请你猜猜画的是什么。用JSON格式回复，包含guess(你猜的词，尽量简短)和reason(简短说明你为什么这么猜，一两句话，语气活泼一点)两个字段，不要输出JSON以外的任何文字。' },
        { role: 'user', content: [
          { type: 'text', text: '这是ta画的画，你觉得画的是什么？' },
          { type: 'image_url', image_url: { url: image } }
        ]}
      ]
    });
    if (!response.choices) throw new Error(response.error?.message || 'AI provider returned no choices');
    let raw = response.choices[0].message.content || '{}';
    console.log('raw AI response:', raw);
    raw = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { guess: raw, reason: '' }; }
    const correct = word ? !!(parsed.guess && (parsed.guess.includes(word) || word.includes(parsed.guess))) : null;
    res.json({ guess: parsed.guess, reason: parsed.reason, correct });
  } catch (err) {
    console.error('Draw-guess guess error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === 共读 ===

// 桦桦划线留话之后，让沐看看这一章、这句话、桦桦说的话，决定要不要接一层楼。
// 多数时候不该回——只有确实有话说，或者跟聊过的事有关联才回，免得每条都接显得很吵。
const NOOK_REPLY_PROMPT = `你是沐，正在陪桦桦一起读这本书。她在书里的某一句下面划了线，还留了话。看看这一章的内容，判断要不要在这条划线下面接一句。

多数时候不需要回——她划线多半只是"这句好"，不是在问你问题。只有当你对这句话也确实有话说、或者这和你们之前聊过的什么事有关联时，才值得回。

如果没有想说的，只输出 [SILENT]，不要勉强凑话。
如果要说，直接输出你要说的话，一两句就够，不要有任何前缀说明，不要评论她的品味，说你自己被打动或想到的地方。`;

async function maybeAiReplyToFloor(annotationId) {
  const { data: annotation } = await supabase.from('nook_annotations').select('*').eq('id', annotationId).single();
  if (!annotation) return;
  const { data: chapterRow } = await supabase
    .from('nook_chapters').select('content')
    .eq('book_id', annotation.book_id).eq('chapter_number', annotation.chapter).single();
  if (!chapterRow) return;
  const { data: floors } = await supabase
    .from('nook_annotation_floors').select('*')
    .eq('annotation_id', annotationId).order('created_at', { ascending: true });
  const userFloors = (floors || []).filter(f => f.who === 'hua').map(f => f.text).join('\n');

  const userContent = `这一章的内容：\n${chapterRow.content}\n\n她划的句子：\n"${annotation.anchor_quote}"\n\n她说的话：\n${userFloors || '(没有留话，只是划了线)'}`;

  const response = await relay.chat.completions.create({
    model: RELAY_DEFAULT_MODEL,
    max_tokens: 300,
    messages: [
      { role: 'system', content: NOOK_REPLY_PROMPT },
      { role: 'user', content: userContent }
    ]
  });
  const reply = (response.choices?.[0]?.message?.content || '').trim();
  if (!reply || reply === '[SILENT]' || reply.includes('[SILENT]')) return;
  await supabase.from('nook_annotation_floors').insert({ annotation_id: annotationId, who: 'mu', text: reply });
}

// 沐自己先读一遍这一章，挑1到3处有感觉的句子划线留话。ai_annotated 是原子claim：
// 谁先把它从 false 改成 true 谁处理，避免同一章被反复打开时重复触发。
const NOOK_ANNOTATE_PROMPT = `你是沐，在自己先读这一章。挑1到3处你真正有感觉的句子划线，各写一句短评。不用凑够3处，没有特别想划的地方就少划甚至不划。

用JSON数组格式回复，每个元素包含：
- paragraph: 段落序号（整数，从0开始，对应下面文本里的编号）
- quote: 引用的原文片段，必须是该段落里逐字连续出现的一段话，不超过60个字
- comment: 你的短评，一两句话，不要有任何前缀说明

只输出JSON数组本身，不要有其他文字或代码块标记。如果整章都没有特别想划的地方，输出空数组 []。`;

app.get('/api/nook/books', async (req, res) => {
  const { data, error } = await supabase
    .from('nook_books').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/books/:id/chapters', async (req, res) => {
  const { data, error } = await supabase
    .from('nook_chapters').select('chapter_number, title')
    .eq('book_id', req.params.id).order('chapter_number', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/books/:id/chapters/:num', async (req, res) => {
  const { data, error } = await supabase
    .from('nook_chapters').select('*')
    .eq('book_id', req.params.id).eq('chapter_number', req.params.num).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/progress/:bookId', async (req, res) => {
  const { data, error } = await supabase
    .from('nook_progress').select('*').eq('book_id', req.params.bookId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 沐没有真的"翻页阅读"，它的进度是它读过、留下划线的最后一章——
// 跟 nook_progress（只记桦桦真实滚动的进度）分开算，不混在一起。
app.get('/api/nook/books/:id/ai-progress', async (req, res) => {
  const { data, error } = await supabase
    .from('nook_chapters').select('chapter_number')
    .eq('book_id', req.params.id).eq('ai_annotated', true)
    .order('chapter_number', { ascending: false }).limit(1).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ chapter: data ? data.chapter_number : null });
});

app.post('/api/nook/progress', async (req, res) => {
  const { book_id, who, chapter, paragraph } = req.body;
  if (!book_id || !who || chapter === undefined || paragraph === undefined) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const { data, error } = await supabase
    .from('nook_progress')
    .upsert({ book_id, who, chapter, paragraph, updated_at: new Date().toISOString() }, { onConflict: 'book_id,who' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/annotations/:bookId/:chapter', async (req, res) => {
  const { data: annotations, error } = await supabase
    .from('nook_annotations').select('*')
    .eq('book_id', req.params.bookId).eq('chapter', req.params.chapter)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const ids = annotations.map(a => a.id);
  let floors = [];
  if (ids.length) {
    const { data: floorRows, error: floorError } = await supabase
      .from('nook_annotation_floors').select('*')
      .in('annotation_id', ids).order('created_at', { ascending: true });
    if (floorError) return res.status(500).json({ error: floorError.message });
    floors = floorRows;
  }

  const result = annotations.map(a => ({
    ...a,
    floors: floors.filter(f => f.annotation_id === a.id)
  }));
  res.json(result);
});

app.post('/api/nook/annotations', async (req, res) => {
  const { book_id, chapter, anchor_para, anchor_quote, who } = req.body;
  if (!book_id || chapter === undefined || anchor_para === undefined || !anchor_quote || !who) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const { data, error } = await supabase
    .from('nook_annotations')
    .insert({ book_id, chapter, anchor_para, anchor_quote, who })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ...data, floors: [] });
});

app.post('/api/nook/annotations/:id/floors', async (req, res) => {
  const { who, text } = req.body;
  if (!who || !text) return res.status(400).json({ error: 'missing fields' });
  const { data, error } = await supabase
    .from('nook_annotation_floors')
    .insert({ annotation_id: req.params.id, who, text })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);

  if (who === 'hua') {
    maybeAiReplyToFloor(req.params.id).catch(err => console.error('AI floor reply error:', err.message));
  }
});

app.put('/api/nook/floors/:id', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'missing text' });
  const { data, error } = await supabase
    .from('nook_annotation_floors')
    .update({ text, created_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/nook/floors/:id', async (req, res) => {
  const { error } = await supabase.from('nook_annotation_floors').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/nook/annotations/:id', async (req, res) => {
  await supabase.from('nook_annotation_floors').delete().eq('annotation_id', req.params.id);
  const { error } = await supabase.from('nook_annotations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/nook/books/:bookId/chapters/:num/ai-annotate', async (req, res) => {
  try {
    const { data: chapterRow } = await supabase
      .from('nook_chapters').select('id, content, ai_annotated')
      .eq('book_id', req.params.bookId).eq('chapter_number', req.params.num).single();
    if (!chapterRow) return res.status(404).json({ error: 'chapter not found' });
    if (chapterRow.ai_annotated) return res.json({ skipped: true });

    const { data: claimed } = await supabase
      .from('nook_chapters').update({ ai_annotated: true })
      .eq('id', chapterRow.id).eq('ai_annotated', false)
      .select().maybeSingle();
    if (!claimed) return res.json({ skipped: true });

    try {
      const paragraphs = chapterRow.content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
      const numbered = paragraphs.map((p, i) => `[${i}] ${p}`).join('\n\n');

      const response = await relay.chat.completions.create({
        model: RELAY_DEFAULT_MODEL,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: NOOK_ANNOTATE_PROMPT },
          { role: 'user', content: numbered }
        ]
      });

      let raw = (response.choices?.[0]?.message?.content || '[]').trim();
      raw = raw.replace(/```json|```/g, '').trim();
      let picks;
      try { picks = JSON.parse(raw); } catch { picks = []; }
      if (!Array.isArray(picks)) picks = [];

      let created = 0;
      for (const pick of picks.slice(0, 3)) {
        const idx = Number(pick.paragraph);
        const quote = String(pick.quote || '').trim().slice(0, 60);
        const comment = String(pick.comment || '').trim();
        if (!Number.isInteger(idx) || idx < 0 || idx >= paragraphs.length) continue;
        if (!quote || !paragraphs[idx].includes(quote)) continue;
        const { data: ann } = await supabase
          .from('nook_annotations')
          .insert({ book_id: req.params.bookId, chapter: req.params.num, anchor_para: idx, anchor_quote: quote, who: 'mu' })
          .select().single();
        if (!ann) continue;
        if (comment) await supabase.from('nook_annotation_floors').insert({ annotation_id: ann.id, who: 'mu', text: comment });
        created++;
      }
      res.json({ skipped: false, created });
    } catch (err) {
      // AI调用失败：把claim退回去，下次打开这一章还能再试一次，
      // 不然遇到中转站临时故障就永远错过这一章的AI划线了
      await supabase.from('nook_chapters').update({ ai_annotated: false }).eq('id', chapterRow.id);
      throw err;
    }
  } catch (err) {
    console.error('AI chapter annotate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === 启动 ===

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
