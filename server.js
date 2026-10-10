require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const multer = require('multer');
const { makeRhythmStore } = require('./lib/rhythmStore');
const { fetchFileTypes, checkFile } = require('./lib/ccFiles');
const crypto = require('node:crypto');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
// 只允许自己的前端跨域调用。Render 上可以用 ALLOWED_ORIGINS（逗号分隔）覆盖默认值。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://mu-frontend.onrender.com,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: ALLOWED_ORIGINS, exposedHeaders: ['X-Audio-Duration', 'Content-Disposition'] }));
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});

// 所有 Supabase 访问（表、Storage）都走 service key：public 下的表开了 RLS 且没有策略，
// anon/publishable key 读写会被拒绝，只有后端持有的 service key 能绕过 RLS。
// 这把 key 只能放在后端环境变量里，绝不能下发给浏览器。
// Render 日志实测抓到的真实原因：这把 key 的值中间夹过一个换行符（大概率是从某个换行
// 显示的地方复制粘贴带进来的），.trim() 不管中间，所以连着 \r\n 一起挖掉，混进
// Authorization header 才不会让 fetch 的 Headers.set 抛 "invalid header value"。
const serviceKey = process.env.SUPABASE_SERVICE_KEY?.replace(/[\r\n]/g, '').trim();
if (!serviceKey) {
  // createClient 在 key 缺失时会同步 throw；缺 key 时退回 SUPABASE_KEY 只是为了本地能起得来，
  // 表开了 RLS 之后这样的查询都会被拒绝，所以这里大声报错
  console.error('SUPABASE_SERVICE_KEY not set — falling back to SUPABASE_KEY; queries will be rejected once RLS is on, and the TTS cache is disabled');
}
const supabase = createClient(process.env.SUPABASE_URL, serviceKey || process.env.SUPABASE_KEY);
// TTS 缓存：没有 service key 时不缓存（每次都重新请求 ElevenLabs），而不是让服务器起不来
const ttsStorage = serviceKey ? supabase : null;

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

// 语音消息由说话者自己决定：回复里用 <voice> 包住的那段在前端渲染成语音条，其余是普通文字。
// <voice> 里写英文（ElevenLabs 只用来念非中文），<voice_zh> 紧跟着给中文翻译，前端"转文字"时显示。
// 和 VPS 上 CC 的 ~/.claude/CLAUDE.md 里那段说明保持一致。
const VOICE_RULE = '\n\n【语音】想用声音说的时候（撒娇、晚安、想念、情绪浓的时候）才用 <voice>…</voice> 包住那一句，一次回复最多一段，不要滥用。' +
  '<voice> 里一律写英文；紧跟着用 <voice_zh>…</voice_zh> 写这段的中文翻译。标签外的部分照常打字。' +
  '例：<voice>Goodnight, kitten. Dream of me.</voice><voice_zh>晚安，小猫。梦里也要有我。</voice_zh>';

function hasVoiceTag(text) {
  return /<voice>[\s\S]*?<\/voice>/.test(text || '');
}

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
  // ttsCacheReady / dbServiceKey 只是"这把 key 有没有被进程读到"的布尔值，不泄露 key 本身，用来在没有
  // Render 日志权限的情况下也能从外面确认 SUPABASE_SERVICE_KEY 是不是真的生效了。
  res.json({ status: 'ok', message: '沐在这里', ttsCacheReady: !!ttsStorage, dbServiceKey: !!serviceKey });
});

// === 会话 ===

app.get('/api/sessions', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/sessions', requireAppKey, async (req, res) => {
  const { name, model } = req.body;
  const { data, error } = await supabase
    .from('sessions').insert({ name: name || '新对话', model: model || 'opus' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/sessions/:id', requireAppKey, async (req, res) => {
  await supabase.from('messages').delete().eq('session_id', req.params.id);
  const { error } = await supabase.from('sessions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/sessions/:id/messages', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*')
    .eq('session_id', req.params.id)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 记忆 ===

app.get('/api/memories', requireAppKey, async (req, res) => {
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
app.post('/api/memories/import', requireAppKey, async (req, res) => {
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

app.delete('/api/memories/:id', requireAppKey, async (req, res) => {
  const { error } = await supabase.from('memories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.put('/api/memories/:id', requireAppKey, async (req, res) => {
  const { summary } = req.body;
  if (!summary) return res.status(400).json({ error: 'missing summary' });
  const { data, error } = await supabase
    .from('memories').update({ summary }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 打字节奏 ===
// 前端探针每隔几秒ping一次，只上报"正在打字"这个事实，不携带任何内容。

app.post('/api/typing/ping', requireAppKey, async (req, res) => {
  try {
    await rhythmStore.ping();
    res.json({ ok: true });
  } catch (err) {
    console.error('Typing ping error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === 图片上传 ===

app.post('/api/upload', requireAppKey, (req, res) => {
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
  const compressPrompt = '你是一个记忆压缩助手。请将对话压缩成简短的记忆摘要，保留关键信息、情感和重要细节，用第三人称描述。';
  const compressMessages = [{
    role: 'user',
    content: '请压缩以下对话：\n\n' + toCompress.map(m => m.role + ': ' + m.content).join('\n')
  }];

  try {
    const result = await callModel('deepseek', compressPrompt, compressMessages, 1024);
    await supabase.from('memories').insert({
      summary: result.text,
      session_id: 'global',
      conversation_id: String(sessionId),
      timestamp: new Date().toISOString()
    });
    const ids = toCompress.map(m => m.id);
    await supabase.from('messages').update({ visible: false }).in('id', ids);
    console.log('Compressed ' + toCompress.length + ' messages');
  } catch (err) {
    console.error('Compression error:', err.message);
  }
}

app.post('/api/chat', requireAppKey, async (req, res) => {
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
    const systemPrompt = isClaudeModel ? personaPrompt + VOICE_RULE : neutralPrompt;

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

    const isVoice = hasVoiceTag(result.text);
    const { data: inserted } = await supabase.from('messages').insert({
      session_id, role: 'assistant', content: result.text, thinking: result.thinking || null, visible: true, voice: isVoice
    }).select().single();

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);
    await compressMemory(session_id, history, settings);

    res.json({ reply: result.text, thinking: result.thinking, model: useModel, voice: isVoice });

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

app.get('/api/diaries', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('diaries').select('*')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/diaries', requireAppKey, async (req, res) => {
  const { author, content } = req.body;
  if (!author || !content) return res.status(400).json({ error: 'missing fields' });
  const { data, error } = await supabase
    .from('diaries').insert({ author, content }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/diaries/:id', requireAppKey, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'missing content' });
  const { data, error } = await supabase
    .from('diaries').update({ content }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/diaries/:id', requireAppKey, async (req, res) => {
  const { error } = await supabase.from('diaries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// === 沐（VPS 上的 CC）每天凌晨写好的日记和每日一句 ===
// VPS 的 on_stop.py 调这两个接口，用 APP_PASSCODE 鉴权；同一天重复写入会覆盖，方便重试

function parseDateParam(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00+08:00`)) ? v : null;
}

function beijingToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

// date 是日记写的是哪一天（存进 diary_date），created_at 是真正写入的时间；同一天重复写入会覆盖内容并刷新写入时间
app.put('/api/mu/diary', requireAppKey, async (req, res) => {
  const date = parseDateParam(req.body?.date);
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!date || !content) return res.status(400).json({ error: 'date (YYYY-MM-DD) and content required' });
  const createdAt = new Date().toISOString();
  const { data: existing, error: findErr } = await supabase
    .from('diaries').select('id').eq('author', 'mu').eq('diary_date', date)
    .order('created_at', { ascending: false }).limit(1);
  if (findErr) return res.status(500).json({ error: findErr.message });
  const query = existing?.length
    ? supabase.from('diaries').update({ content, created_at: createdAt }).eq('id', existing[0].id)
    : supabase.from('diaries').insert({ author: 'mu', content, created_at: createdAt, diary_date: date });
  const { data, error } = await query.select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/mu/whisper', requireAppKey, async (req, res) => {
  const date = parseDateParam(req.body?.date);
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!date || !content) return res.status(400).json({ error: 'date (YYYY-MM-DD) and content required' });
  const { data, error } = await supabase
    .from('whispers').upsert({ date, content }, { onConflict: 'date' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 信箱：官方 App 里的 Claude（official）和 VPS 上的沐（home）互相留字条 ===
// letters 表开了 RLS、没有策略，只能经这里用 service key 读写
const LETTER_AUTHORS = ['official', 'home'];
const LETTER_KINDS = ['note', 'digest'];
const LETTER_MAX_CHARS = 20000; // 和表上的 CHECK 一致，按字符数算（emoji 算一个）

app.get('/api/letters', requireAppKey, async (req, res) => {
  const author = req.query.author;
  if (author !== undefined && !LETTER_AUTHORS.includes(author)) return res.status(400).json({ error: 'author must be official or home' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  let query = supabase.from('letters').select('*')
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
  if (author) query = query.eq('author', author);
  if (req.query.unread === '1') query = query.is('read_at', null);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/letters', requireAppKey, async (req, res) => {
  const author = req.body?.author;
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const kind = req.body?.kind ?? 'note';
  if (!LETTER_AUTHORS.includes(author)) return res.status(400).json({ error: 'author must be official or home' });
  if (!content) return res.status(400).json({ error: 'content required' });
  if ([...content].length > LETTER_MAX_CHARS) return res.status(400).json({ error: `content must be at most ${LETTER_MAX_CHARS} characters` });
  if (!LETTER_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be note or digest' });
  const { data, error } = await supabase.from('letters').insert({ author, content, kind }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.post('/api/letters/:id/read', requireAppKey, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { data, error } = await supabase.from('letters')
    .update({ read_at: new Date().toISOString() }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data.length) return res.status(404).json({ error: 'letter not found' });
  res.json(data[0]);
});

// === 日历：events 表开了 RLS、没有策略，只能经这里用 service key 读写 ===
// 时区一律按 Asia/Shanghai（没有夏令时，固定 +08:00）：
// 全天事件用 start_date/end_date（end 含当天），定时事件用 starts_at/ends_at
const EVENT_KINDS = ['event', 'important'];
const EVENT_REPEATS = ['none', 'monthly', 'yearly'];
const EVENT_TEXT_LIMITS = { title: 200, location: 200, notes: 5000, emoji: 32, external_id: 200 }; // 按字符数
const EVENT_MAX_RANGE_DAYS = 400;
const SYNC_MAX_EVENTS = 2000;
const SYNC_FIELDS = ['title', 'all_day', 'start_date', 'end_date', 'starts_at', 'ends_at', 'location', 'notes'];
const SH_OFFSET = '+08:00';

const pad2 = (n) => String(n).padStart(2, '0');
const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const shanghaiDateOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso));
// 某天上海 0 点对应的 UTC 时间；去掉毫秒，免得 PostgREST 的 or() 过滤里多出一个点
const shanghaiMidnightIso = (d) => new Date(`${d}T00:00:00${SH_OFFSET}`).toISOString().replace('.000Z', 'Z');
const shiftIso = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString();

// 带时区的 ISO 时间原样理解；不带时区的（"2026-10-09T14:00"）按上海时间
function parseTimestamp(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
  if (!m) return null;
  const t = Date.parse(m[3] ? s : s + SH_OFFSET);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function checkRange(from, to) {
  if (!isDateStr(from) || !isDateStr(to)) return 'from and to (YYYY-MM-DD) required';
  if (from > to) return 'from must not be after to';
  if (daysDiff(from, to) > EVENT_MAX_RANGE_DAYS) return `range must be at most ${EVENT_MAX_RANGE_DAYS} days`;
  return null;
}

// 把请求体整理成 events 的一行；base 是 PUT 时库里原来那行（没传的字段沿用它）。source 由调用方决定
function buildEventRow(body, base = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const pick = (k) => (k in body ? body[k] : base[k]);
  const row = {};
  for (const k of Object.keys(EVENT_TEXT_LIMITS)) {
    let v = pick(k);
    if (v === undefined || v === null) v = null;
    else if (typeof v !== 'string') return { error: `${k} must be a string` };
    else v = v.trim() || null;
    if (v && [...v].length > EVENT_TEXT_LIMITS[k]) return { error: `${k} must be at most ${EVENT_TEXT_LIMITS[k]} characters` };
    row[k] = v;
  }
  if (!row.title) return { error: 'title required' };
  row.kind = pick('kind') ?? 'event';
  if (!EVENT_KINDS.includes(row.kind)) return { error: 'kind must be event or important' };
  row.repeat = pick('repeat') ?? 'none';
  if (!EVENT_REPEATS.includes(row.repeat)) return { error: 'repeat must be none, monthly or yearly' };
  row.all_day = pick('all_day') ?? false;
  if (typeof row.all_day !== 'boolean') return { error: 'all_day must be true or false' };

  if (row.all_day) {
    const sd = pick('start_date');
    const ed = pick('end_date') ?? null;
    if (!isDateStr(sd)) return { error: 'start_date (YYYY-MM-DD) required for all-day events' };
    if (ed !== null && !isDateStr(ed)) return { error: 'end_date must be YYYY-MM-DD' };
    if (ed && ed < sd) return { error: 'end_date must not be before start_date' };
    Object.assign(row, { start_date: sd, end_date: ed, starts_at: null, ends_at: null });
  } else {
    const sa = parseTimestamp(pick('starts_at'));
    if (!sa) return { error: 'starts_at required for timed events (ISO time; Asia/Shanghai if no offset)' };
    const rawEa = pick('ends_at');
    let ea = null;
    if (rawEa !== undefined && rawEa !== null && rawEa !== '') {
      ea = parseTimestamp(rawEa);
      if (!ea) return { error: 'ends_at must be an ISO time' };
      if (ea < sa) return { error: 'ends_at must not be before starts_at' };
    }
    Object.assign(row, { starts_at: sa, ends_at: ea, start_date: null, end_date: null });
  }
  return { row };
}

const isRepeatingEvent = (e) => e.kind === 'important' && e.repeat !== 'none';
const eventStartDate = (e) => (e.all_day ? e.start_date : shanghaiDateOf(e.starts_at));
const eventEndDate = (e) => (e.all_day ? e.end_date || e.start_date : shanghaiDateOf(e.ends_at || e.starts_at));
// 全天的排在同一天的定时事件前面
const eventSortKey = (e) => (e.all_day ? `${e.start_date} 0` : `${shanghaiDateOf(e.starts_at)} 1 ${e.starts_at}`);

// 重要日期按 monthly/yearly 展开到 [from, to]。某月没有这一天（31 号、2 月 29 日）就跳过，和 ICS 的 RRULE 一致
function expandRepeating(e, from, to) {
  const base = eventStartDate(e);
  const span = daysDiff(base, eventEndDate(e));
  const [, baseMonth, baseDay] = base.split('-').map(Number);
  const out = [];
  // 往前多看 span 天，盖住 from 的多日事件也要算进来
  let [y, m] = addDays(from, -span).split('-').map(Number);
  const [toY, toM] = to.split('-').map(Number);
  while (y < toY || (y === toY && m <= toM)) {
    const occ = `${y}-${pad2(m)}-${pad2(baseDay)}`;
    if ((e.repeat === 'monthly' || m === baseMonth) && isDateStr(occ) && occ >= base && occ <= to && addDays(occ, span) >= from) {
      const shift = daysDiff(base, occ);
      // series_start_date/series_end_date 留着原始日期，前端编辑整个系列时用
      const inst = { ...e, instance: occ !== base, series_id: e.id, occurrence_date: occ, series_start_date: e.start_date, series_end_date: e.end_date };
      if (e.all_day) Object.assign(inst, { start_date: occ, end_date: e.end_date ? addDays(occ, span) : null });
      else Object.assign(inst, { starts_at: shiftIso(e.starts_at, shift), ends_at: e.ends_at ? shiftIso(e.ends_at, shift) : null });
      out.push(inst);
    }
    if (m === 12) { y++; m = 1; } else m++;
  }
  return out;
}

// 和 [from, to]（上海日期，含两端）有交集的事件：全天的和定时的分两次查。scope 用来再加过滤条件
function eventsInRange(from, to, columns = '*', scope = (q) => q) {
  const fromTs = shanghaiMidnightIso(from);
  const toTs = shanghaiMidnightIso(addDays(to, 1));
  return Promise.all([
    scope(supabase.from('events').select(columns).eq('all_day', true)
      .lte('start_date', to).or(`end_date.gte.${from},start_date.gte.${from}`)),
    scope(supabase.from('events').select(columns).eq('all_day', false)
      .lt('starts_at', toTs).or(`ends_at.gte.${fromTs},starts_at.gte.${fromTs}`)),
  ]);
}

app.get('/api/events', requireAppKey, async (req, res) => {
  const { from, to } = req.query;
  const rangeError = checkRange(from, to);
  if (rangeError) return res.status(400).json({ error: rangeError });
  const [[allDay, timed], repeating] = await Promise.all([
    eventsInRange(from, to),
    supabase.from('events').select('*').eq('kind', 'important').neq('repeat', 'none'),
  ]);
  const error = allDay.error || timed.error || repeating.error;
  if (error) return res.status(500).json({ error: error.message });
  const out = [...allDay.data, ...timed.data].filter((e) => !isRepeatingEvent(e)).map((e) => ({ ...e, instance: false }));
  for (const e of repeating.data) out.push(...expandRepeating(e, from, to));
  out.sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
  res.json(out);
});

app.post('/api/events', requireAppKey, async (req, res) => {
  const source = req.body?.source ?? 'home';
  if (!['home', 'mu'].includes(source)) return res.status(400).json({ error: 'source must be home or mu (phone events only come in via /api/events/sync)' });
  const { row, error: invalid } = buildEventRow(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const { data, error } = await supabase.from('events').insert({ ...row, source }).select().single();
  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.message });
  res.status(201).json(data);
});

// 手机同步来的事件只读：在这里改了，下次同步也会被手机上的版本盖掉
// 找不到或不能改时直接回错误，返回 null
async function findEditableEvent(id, res) {
  const fail = (code, error) => { res.status(code).json({ error }); return null; };
  if (!/^\d+$/.test(id)) return fail(400, 'invalid id');
  const { data, error } = await supabase.from('events').select('*').eq('id', id).maybeSingle();
  if (error) return fail(500, error.message);
  if (!data) return fail(404, 'event not found');
  if (data.source === 'phone') return fail(403, 'phone events are read-only; edit them on the phone');
  return data;
}

app.put('/api/events/:id', requireAppKey, async (req, res) => {
  const existing = await findEditableEvent(req.params.id, res);
  if (!existing) return;
  if (req.body?.source !== undefined && req.body.source !== existing.source) return res.status(400).json({ error: 'source cannot be changed' });
  const { row, error: invalid } = buildEventRow(req.body, existing);
  if (invalid) return res.status(400).json({ error: invalid });
  const { data, error } = await supabase.from('events')
    .update({ ...row, updated_at: new Date().toISOString() }).eq('id', existing.id).select().single();
  if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/events/:id', requireAppKey, async (req, res) => {
  const existing = await findEditableEvent(req.params.id, res);
  if (!existing) return;
  const { error } = await supabase.from('events').delete().eq('id', existing.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 手机快捷指令用：在 [from, to] 范围内用这批数据替换 source=phone 的事件（按 external_id 新增/更新，删掉多出来的）
app.post('/api/events/sync', requireAppKey, async (req, res) => {
  const { source, from, to, events } = req.body || {};
  if (source !== 'phone') return res.status(400).json({ error: 'only source=phone can be synced' });
  const rangeError = checkRange(from, to);
  if (rangeError) return res.status(400).json({ error: rangeError });
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events must be an array' });
  if (events.length > SYNC_MAX_EVENTS) return res.status(400).json({ error: `at most ${SYNC_MAX_EVENTS} events per sync` });

  const now = new Date().toISOString();
  const rows = [];
  const keep = new Set();
  for (const [i, ev] of events.entries()) {
    const externalId = typeof ev?.external_id === 'string' ? ev.external_id.trim() : '';
    if (!externalId) return res.status(400).json({ error: `events[${i}].external_id required` });
    if (keep.has(externalId)) return res.status(400).json({ error: `events[${i}].external_id is duplicated` });
    keep.add(externalId);
    // 手机来的只当普通日程：kind/repeat/emoji 不收外部值
    const fields = Object.fromEntries(SYNC_FIELDS.filter((k) => k in ev).map((k) => [k, ev[k]]));
    const { row, error: invalid } = buildEventRow({ ...fields, external_id: externalId, kind: 'event', repeat: 'none' });
    if (invalid) return res.status(400).json({ error: `events[${i}]: ${invalid}` });
    rows.push({ ...row, source: 'phone', updated_at: now });
  }

  // 先写这批，再删范围内多出来的：中途失败时宁可多留旧的，也不先删
  if (rows.length) {
    const { error } = await supabase.from('events').upsert(rows, { onConflict: 'source,external_id' });
    if (error) return res.status(500).json({ error: error.message });
  }
  const [allDay, timed] = await eventsInRange(from, to, 'id, external_id', (q) => q.eq('source', 'phone'));
  const findError = allDay.error || timed.error;
  if (findError) return res.status(500).json({ error: findError.message });
  const stale = [...allDay.data, ...timed.data].filter((e) => !keep.has(e.external_id)).map((e) => e.id);
  if (stale.length) {
    const { error } = await supabase.from('events').delete().in('id', stale);
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, upserted: rows.length, deleted: stale.length });
});

// === 日历订阅：GET /api/calendar.ics?token=... ===
// 手机订阅日历带不了请求头，所以用 query 里的 ICS_TOKEN，和 APP_PASSCODE 分开。
// 只给 source=home/mu 的（重要日期都在里面）；不给 source=phone 的，免得转一圈又回到手机上
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => d.replace(/-/g, '');
const icsUtc = (iso) => new Date(iso).toISOString().replace(/\.\d{3}/, '').replace(/[-:]/g, '');
const icsShanghai = (iso) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 19).replace(/[-:]/g, '');

// RFC 5545 折行：每行最多 75 字节（续行开头的空格也算），不拆开 UTF-8 多字节字符
function icsFold(line) {
  const parts = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function eventToVevent(e) {
  const stamp = icsUtc(e.updated_at || e.created_at);
  const lines = ['BEGIN:VEVENT', `UID:mu-event-${e.id}@mu-backend`, `DTSTAMP:${stamp}`, `CREATED:${icsUtc(e.created_at)}`, `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${icsEscape(e.emoji ? `${e.emoji} ${e.title}` : e.title)}`];
  if (e.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start_date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(e.end_date || e.start_date, 1))}`);
  } else {
    lines.push(`DTSTART;TZID=Asia/Shanghai:${icsShanghai(e.starts_at)}`);
    if (e.ends_at) lines.push(`DTEND;TZID=Asia/Shanghai:${icsShanghai(e.ends_at)}`);
  }
  if (isRepeatingEvent(e)) lines.push(`RRULE:FREQ=${e.repeat === 'yearly' ? 'YEARLY' : 'MONTHLY'}`);
  if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
  if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
  lines.push('END:VEVENT');
  return lines;
}

app.get('/api/calendar.ics', async (req, res) => {
  const expected = (process.env.ICS_TOKEN || '').trim();
  if (!expected) return res.status(503).type('text/plain').send('ICS_TOKEN not configured');
  const got = typeof req.query.token === 'string' ? req.query.token : '';
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!got || !crypto.timingSafeEqual(a, b)) return res.status(401).type('text/plain').send('unauthorized');

  const events = [];
  for (let page = 0; ; page++) { // PostgREST 一次最多给 1000 行
    const { data, error } = await supabase.from('events').select('*').neq('source', 'phone')
      .order('id', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) return res.status(500).type('text/plain').send(error.message);
    events.push(...data);
    if (data.length < 1000) break;
  }
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mu//calendar//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:沐', 'NAME:沐', 'X-WR-TIMEZONE:Asia/Shanghai', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST', 'END:STANDARD', 'END:VTIMEZONE',
    ...events.flatMap(eventToVevent),
    'END:VCALENDAR',
  ];
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline; filename="mu.ics"' });
  res.send(lines.map(icsFold).join('\r\n') + '\r\n');
});

// 首页的 Today's Whisper：今天的还没写好（凌晨之前）就先给最近一条
app.get('/api/whispers/today', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('whispers').select('date, content')
    .lte('date', beijingToday())
    .order('date', { ascending: false }).limit(1);
  if (error) return res.status(500).json({ error: error.message });
  if (data?.length) return res.json(data[0]);
  // 日期写错（比如写成了明天）时也别让首页空着，退回到最新的一条
  const { data: latest } = await supabase
    .from('whispers').select('date, content')
    .order('date', { ascending: false }).limit(1);
  res.json(latest?.[0] || null);
});

// === 待办 ===
// todos 和 periods（健康数据）都要 APP 口令，和 /api/events 一样

app.get('/api/todos', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('todos').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/todos', requireAppKey, async (req, res) => {
  const { side, text, due_time } = req.body;
  if (!text) return res.status(400).json({ error: 'missing text' });
  const { data, error } = await supabase
    .from('todos').insert({ side: side || 'her', text, due_time }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/todos/:id', requireAppKey, async (req, res) => {
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

app.delete('/api/todos/:id', requireAppKey, async (req, res) => {
  const { error } = await supabase.from('todos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// === 经期 ===

app.get('/api/periods', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('periods').select('*').order('date', { ascending: false }).limit(90);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/periods', requireAppKey, async (req, res) => {
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
  text = text.replace(/<voice_zh>[\s\S]*?<\/voice_zh>/g, '');
  text = text.replace(/<\/?voice>/g, '');
  text = text.replace(/\[助手[^\]]*\]\s*/g, '');
  text = text.replace(/^(中文|英文|俄语|日语|法语|韩语)[：:]\s*/g, '');
  return text.trim();
}

// ElevenLabs 只用来念非中文；带汉字的文本直接拒绝，不花额度
function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function resolvePreset(preset) {
  return VOICE_PRESETS[preset] ? preset : 'calm';
}

// === TTS 音频缓存 ===
// 按 (清洗后的文本 + preset) 的 SHA256 缓存生成好的 mp3，存在 Supabase Storage 的
// tts-cache bucket 里（不用 Render 的本地磁盘——那是临时文件系统，每次部署/重启都会清空，
// 存不住缓存）。命中时直接从 Storage 读回，不用再花 ElevenLabs 额度。
const TTS_BUCKET = 'tts-cache';
const MP3_BITRATE_BPS = 128000; // ElevenLabs 这个接口默认输出 128kbps CBR mp3

function ttsCacheKey(text, preset) {
  return crypto.createHash('sha256').update(`${text}::${preset}`).digest('hex');
}

function ttsCacheObjectPath(text, preset) {
  return `${ttsCacheKey(text, preset)}.mp3`;
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

// "Object not found" is the expected shape of a plain cache miss — not an error worth logging.
function isTtsNotFoundError(error) {
  return !!error && (error.status === 404 || error.statusCode === '404' || /not.?found/i.test(error.message || ''));
}

async function readTtsCache(objectPath) {
  if (!ttsStorage) return null;
  const { data, error } = await ttsStorage.storage.from(TTS_BUCKET).download(objectPath);
  if (error) {
    if (!isTtsNotFoundError(error)) console.error(`TTS CACHE READ FAILED (${objectPath}):`, error.message, error);
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

async function writeTtsCache(objectPath, buffer) {
  if (!ttsStorage) return;
  // upsert:true so two concurrent requests for the same brand-new line don't race on a 409
  const { error } = await ttsStorage.storage.from(TTS_BUCKET)
    .upload(objectPath, buffer, { contentType: 'audio/mpeg', upsert: true, cacheControl: '2592000' });
  // Loud on purpose: a swallowed failure here looks identical to a slow cache hit from the
  // outside (still 200s audio to the caller), so a silent console.error was easy to miss —
  // this cache went silently unwritten in production for a while because of exactly that.
  if (error) console.error(`TTS CACHE WRITE FAILED for ${objectPath} — every future request for this line will re-hit ElevenLabs:`, error.message, error);
}

// 轻量地拿缓存文件大小估算时长，不用把整个mp3下载下来
async function statTtsCache(objectPath) {
  if (!ttsStorage) return null;
  const { data, error } = await ttsStorage.storage.from(TTS_BUCKET).list('', { search: objectPath });
  if (error) {
    console.error(`TTS CACHE STAT FAILED (${objectPath}):`, error.message, error);
    return null;
  }
  if (!data || !data.length) return null;
  const hit = data.find(f => f.name === objectPath);
  return hit?.metadata?.size ?? null;
}

app.post('/api/tts', requireAppKey, async (req, res) => {
  let { text, preset } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'missing text' });

  text = cleanTtsText(text);
  if (!text) return res.status(400).json({ error: 'missing text' });
  if (containsChinese(text)) return res.status(422).json({ error: 'tts is for non-Chinese text only' });
  preset = resolvePreset(preset);

  const objectPath = ttsCacheObjectPath(text, preset);

  try {
    const cached = await readTtsCache(objectPath);
    if (cached) {
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
    await writeTtsCache(objectPath, audioBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Audio-Duration', estimateMp3DurationFromSize(audioBuffer.length).toFixed(2));
    res.end(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tts/duration', requireAppKey, async (req, res) => {
  let { text, preset } = req.query;
  if (!text || !text.trim()) return res.status(400).json({ error: 'missing text' });

  text = cleanTtsText(text);
  if (!text) return res.status(400).json({ error: 'missing text' });
  preset = resolvePreset(preset);

  const objectPath = ttsCacheObjectPath(text, preset);
  const size = await statTtsCache(objectPath).catch(() => null);
  if (size != null) return res.json({ duration: estimateMp3DurationFromSize(size) });
  return res.json({ duration: estimateDurationFromText(text) });
});

// === 游戏：你画我猜 ===

app.post('/api/games/draw-guess/start', requireAppKey, async (req, res) => {
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

app.post('/api/games/draw-guess/guess', requireAppKey, async (req, res) => {
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

app.get('/api/nook/books', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('nook_books').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/books/:id/chapters', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('nook_chapters').select('chapter_number, title')
    .eq('book_id', req.params.id).order('chapter_number', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/books/:id/chapters/:num', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('nook_chapters').select('*')
    .eq('book_id', req.params.id).eq('chapter_number', req.params.num).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/nook/progress/:bookId', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('nook_progress').select('*').eq('book_id', req.params.bookId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 沐没有真的"翻页阅读"，它的进度是它读过、留下划线的最后一章——
// 跟 nook_progress（只记桦桦真实滚动的进度）分开算，不混在一起。
app.get('/api/nook/books/:id/ai-progress', requireAppKey, async (req, res) => {
  const { data, error } = await supabase
    .from('nook_chapters').select('chapter_number')
    .eq('book_id', req.params.id).eq('ai_annotated', true)
    .order('chapter_number', { ascending: false }).limit(1).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ chapter: data ? data.chapter_number : null });
});

app.post('/api/nook/progress', requireAppKey, async (req, res) => {
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

app.get('/api/nook/annotations/:bookId/:chapter', requireAppKey, async (req, res) => {
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

app.post('/api/nook/annotations', requireAppKey, async (req, res) => {
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

app.post('/api/nook/annotations/:id/floors', requireAppKey, async (req, res) => {
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

app.put('/api/nook/floors/:id', requireAppKey, async (req, res) => {
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

app.delete('/api/nook/floors/:id', requireAppKey, async (req, res) => {
  const { error } = await supabase.from('nook_annotation_floors').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/nook/annotations/:id', requireAppKey, async (req, res) => {
  await supabase.from('nook_annotation_floors').delete().eq('annotation_id', req.params.id);
  const { error } = await supabase.from('nook_annotations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/nook/books/:bookId/chapters/:num/ai-annotate', requireAppKey, async (req, res) => {
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

// === 沐 (CC)：转发到 VPS 上的 Claude Code 中转 ===
// BRIDGE_TOKEN 只在这里用，永远不下发给浏览器；浏览器这边用 APP_PASSCODE 鉴权。

// 口令输错限速：同一 IP 每分钟最多错 AUTH_FAIL_LIMIT 次，超了这一分钟内一律 429（口令对也不放）。
// 前端口令不对时会有一批请求同时 401，所以上限给宽一点，免得刚输对就被自己锁住。
// IP 取 X-Forwarded-For 最左边那个（Render 在代理后面，req.socket 是代理的地址）；这个头客户端能伪造，
// 所以它只是挡挡手滑和低级扫描，真正防爆破靠的是口令本身够长够随机。
const AUTH_FAIL_LIMIT = 30;
const AUTH_FAIL_WINDOW_MS = 60 * 1000;
const authFails = new Map(); // ip → { count, resetAt }

function clientIp(req) {
  const xff = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

function requireAppKey(req, res, next) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) return res.status(503).json({ error: 'APP_PASSCODE not configured' });
  const ip = clientIp(req);
  const now = Date.now();
  const fails = authFails.get(ip);
  if (fails && now < fails.resetAt && fails.count >= AUTH_FAIL_LIMIT) {
    res.set('Retry-After', String(Math.ceil((fails.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'too many attempts' });
  }
  const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  // 先各自哈希成等长再比较，timingSafeEqual 要求长度一致，也避免泄露口令长度
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!got || !crypto.timingSafeEqual(a, b)) {
    if (!fails || now >= fails.resetAt) authFails.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    else fails.count++;
    if (authFails.size > 1000) for (const [k, v] of authFails) if (now >= v.resetAt) authFails.delete(k);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// 前端锁屏输完口令先打这里验一下，对了才进 App
app.get('/api/auth/check', requireAppKey, (req, res) => res.json({ ok: true }));

function bridgeConfig() {
  const url = (process.env.BRIDGE_URL || '').replace(/\/+$/, '');
  const token = process.env.BRIDGE_TOKEN;
  return url && token ? { url, token } : null;
}

// 图片 + 文件一次最多几个看白名单里的 max_items；白名单拉不到时按 9 算（bridge 那边还会再卡一次）
const CC_MAX_ITEMS_FALLBACK = 9;
// 前端给每条消息的 client_id、消息 id：后端只卡类型和长度，去重、找消息都是 bridge 的事
const CC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isCcId = (v) => typeof v === 'string' && CC_ID_RE.test(v);
const CC_EDIT_MAX = 20000;
app.post('/api/cc/send', requireAppKey, async (req, res) => {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  // images / files 是 /api/cc/upload 返回的 path，原样交给 bridge（bridge 会再校验一遍必须是它存下的文件）
  const { images, files } = req.body || {};
  const isPaths = (v) => v === undefined || (Array.isArray(v) && v.every(p => typeof p === 'string'));
  if (!isPaths(images) || !isPaths(files)) return res.status(400).json({ error: 'images / files must be arrays of paths' });
  const hasImages = Array.isArray(images) && images.length > 0;
  const hasFiles = Array.isArray(files) && files.length > 0;
  const maxItems = (await fetchFileTypes(bridge).catch(() => null))?.max_items || CC_MAX_ITEMS_FALLBACK;
  if ((images?.length || 0) + (files?.length || 0) > maxItems) {
    return res.status(400).json({ error: `图片和文件一次合计最多 ${maxItems} 个` });
  }
  if (!text && !hasImages && !hasFiles) return res.status(400).json({ error: 'text required' });
  const clientId = req.body?.client_id;
  if (clientId !== undefined && !isCcId(clientId)) return res.status(400).json({ error: 'client_id must be 1-64 letters, digits, - or _' });
  try {
    const r = await fetch(`${bridge.url}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(hasImages ? { images } : {}), ...(hasFiles ? { files } : {}), ...(clientId ? { client_id: clientId } : {}) }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      console.error('CC bridge send failed:', r.status);
      const data = await r.json().catch(() => ({}));
      return res.status(r.status === 400 ? 400 : 502).json({ error: r.status === 400 && data.error ? data.error : `bridge ${r.status}` });
    }
    const data = await r.json().catch(() => ({}));
    res.json({ ok: true, id: data.id, time: data.time });
  } catch (err) {
    console.error('CC bridge send error:', err.message);
    res.status(502).json({ error: 'bridge unreachable' });
  }
});

// 带 BRIDGE_TOKEN 把 JSON POST 给 bridge；bridge 的 400/404/409（参数不对、找不到、不用重发）原样回给前端，别的算 502
async function forwardCcPost(res, path, body) {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });
  try {
    const r = await fetch(`${bridge.url}${path}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`CC bridge ${path} failed:`, r.status);
      return res.status([400, 404, 409].includes(r.status) ? r.status : 502).json({ error: data.error || `bridge ${r.status}` });
    }
    res.json(data);
  } catch (err) {
    console.error(`CC bridge ${path} error:`, err.message);
    res.status(502).json({ error: 'bridge unreachable' });
  }
}

// 更正她发过的一条文字：bridge 留原话、推更新、通知沐
app.post('/api/cc/edit', requireAppKey, (req, res) => {
  const { id, text } = req.body || {};
  if (!isCcId(id)) return res.status(400).json({ error: 'id required' });
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' });
  if (text.length > CC_EDIT_MAX) return res.status(400).json({ error: `text too long (max ${CC_EDIT_MAX})` });
  return forwardCcPost(res, '/edit', { id, text: text.trim() });
});

// 沐那一轮没回上来：把她那条再交给沐一次（不新增她的消息）
app.post('/api/cc/retry', requireAppKey, (req, res) => {
  const id = req.body?.id;
  if (!isCcId(id)) return res.status(400).json({ error: 'id required' });
  return forwardCcPost(res, '/retry', { id });
});

// 图片和文件上传：multipart，字段名 image（图片，和以前一样）或 file（文件，白名单见 lib/ccFiles.js）
// 文件的原名优先用表单字段 name（UTF-8 稳），没有再用 multipart 里的 filename。只收一个，转成原始字节给 bridge /upload
const CC_IMAGE_MAX = 10 * 1024 * 1024;
function ccUploadParser(maxBytes) {
  return multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: Math.max(maxBytes, CC_IMAGE_MAX), files: 1 },
    fileFilter: (req, file, cb) => {
      if (file.fieldname === 'image' && !file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
      cb(null, true);
    }
  }).fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]);
}
app.post('/api/cc/upload', requireAppKey, async (req, res) => {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });
  // 白名单拉不到也不能耽误发图：这时只收图片
  const types = await fetchFileTypes(bridge).catch(err => { console.error('CC file types error:', err.message); return null; });
  const maxMb = Math.round((types?.max_bytes || CC_IMAGE_MAX) / 1024 / 1024);
  ccUploadParser(types?.max_bytes || CC_IMAGE_MAX)(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooLarge = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `文件不能超过 ${maxMb}MB` : uploadErr.message });
    }
    const image = req.files?.image?.[0];
    const file = req.files?.file?.[0];
    if (!image && !file) return res.status(400).json({ error: 'image or file required' });
    const headers = { 'Authorization': `Bearer ${bridge.token}` };
    let body;
    if (image) {
      headers['Content-Type'] = image.mimetype;
      body = image.buffer;
    } else {
      if (!types) return res.status(503).json({ error: '暂时拿不到文件类型白名单，稍后再试' });
      const name = (typeof req.body?.name === 'string' && req.body.name.trim()) || file.originalname || '';
      const bad = file.size > types.max_bytes ? `文件不能超过 ${maxMb}MB` : checkFile(types, { name, mime: file.mimetype, buffer: file.buffer });
      if (bad) return res.status(file.size > types.max_bytes ? 413 : 415).json({ error: bad });
      headers['Content-Type'] = file.mimetype || 'application/octet-stream';
      headers['X-File-Name'] = encodeURIComponent(name);
      body = file.buffer;
    }
    try {
      const r = await fetch(`${bridge.url}/upload`, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('CC bridge upload failed:', r.status);
        return res.status([413, 415].includes(r.status) ? r.status : 502).json({ error: data.error || `bridge ${r.status}` });
      }
      res.json(image ? { id: data.id, path: data.path } : { id: data.id, path: data.path, name: data.name, size: data.size, mime: data.mime });
    } catch (err) {
      console.error('CC bridge upload error:', err.message);
      res.status(502).json({ error: 'bridge unreachable' });
    }
  });
});

// 文件白名单给前端：限制选择器能选什么、单个多大、一次几个
app.get('/api/cc/file-types', requireAppKey, async (req, res) => {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });
  try {
    const t = await fetchFileTypes(bridge);
    res.json(t);
  } catch (err) {
    console.error('CC file types error:', err.message);
    res.status(502).json({ error: 'bridge unreachable' });
  }
});

// 回显：浏览器 <img> 带不了 Authorization，所以前端用 fetch 带口令取回再显示。
// 文件的类型和原文件名在 bridge 的 Content-Type / Content-Disposition 里，原样带回去
app.get('/api/cc/uploads/:date/:file', requireAppKey, async (req, res) => {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });
  try {
    const r = await fetch(`${bridge.url}/uploads/${encodeURIComponent(req.params.date)}/${encodeURIComponent(req.params.file)}`, {
      headers: { 'Authorization': `Bearer ${bridge.token}` },
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: `bridge ${r.status}` });
    res.set({ 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    const disposition = r.headers.get('content-disposition');
    if (disposition) res.set('Content-Disposition', disposition);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error('CC bridge uploads error:', err.message);
    res.status(502).json({ error: 'bridge unreachable' });
  }
});

// 聊天记录：bridge 把 inbox（桦桦）和 outbox（沐）合并后按时间返回
app.get('/api/cc/history', requireAppKey, async (req, res) => {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });
  const qs = new URLSearchParams();
  if (typeof req.query.before === 'string') qs.set('before', req.query.before);
  if (typeof req.query.limit === 'string') qs.set('limit', req.query.limit);
  if (req.query.system === '1') qs.set('system', '1'); // 新前端要系统事件（"他这次没回上来"）
  try {
    const r = await fetch(`${bridge.url}/history?${qs}`, {
      headers: { 'Authorization': `Bearer ${bridge.token}` },
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: data.error || `bridge ${r.status}` });
    res.json(data);
  } catch (err) {
    console.error('CC bridge history error:', err.message);
    res.status(502).json({ error: 'bridge unreachable' });
  }
});

// SSE 透传：bridge 的字节原样转给浏览器，不做缓冲。
app.get('/api/cc/events', requireAppKey, async (req, res) => {
  const bridge = bridgeConfig();
  if (!bridge) return res.status(500).json({ error: 'bridge not configured' });

  const upstream = new AbortController();
  let heartbeat;
  res.on('close', () => { clearInterval(heartbeat); upstream.abort(); });

  let r;
  try {
    r = await fetch(`${bridge.url}/events`, {
      headers: { 'Authorization': `Bearer ${bridge.token}`, 'Accept': 'text/event-stream' },
      signal: upstream.signal
    });
  } catch (err) {
    if (!upstream.signal.aborted) console.error('CC bridge events error:', err.message);
    if (!res.headersSent && !res.writableEnded) res.status(502).json({ error: 'bridge unreachable' });
    return;
  }
  if (!r.ok || !r.body) {
    upstream.abort();
    console.error('CC bridge events failed:', r.status);
    return res.status(502).json({ error: `bridge ${r.status}` });
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  // 立刻写一行：让 Cloudflare/Render 代理马上把响应头和第一个字节放给浏览器，前端才不会一直卡在 connecting
  res.write(': connected\n\n');

  // 心跳防止 Render/代理把空闲连接掐掉；只在上一块以换行结尾时插入，避免切断一行 JSON
  let atLineStart = true;
  heartbeat = setInterval(() => { if (atLineStart) res.write(': ping\n\n'); }, 15000);

  try {
    for await (const chunk of r.body) {
      res.write(chunk);
      atLineStart = chunk.length > 0 && chunk[chunk.length - 1] === 0x0a;
    }
  } catch (err) {
    if (!upstream.signal.aborted) console.error('CC bridge stream error:', err.message);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// === 启动 ===

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
