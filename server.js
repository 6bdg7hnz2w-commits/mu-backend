require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
  baseURL: 'https://openrouter.ai/api/v1'
});

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'placeholder',
  baseURL: 'https://api.deepseek.com'
});

const MODEL_MAP = {
  'opus': 'anthropic/claude-opus-4.6',
  'sonnet': 'anthropic/claude-sonnet-4.6',
  'sonnet5': 'anthropic/claude-sonnet-5',
  'deepseek': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '沐在这里' });
});

// Temporary diagnostic route to check Render's outbound IP — remove after confirming region block cause.
app.get('/debug/egress-ip', async (req, res) => {
  try {
    const ip = await fetch('https://ifconfig.me').then(r => r.text());
    res.json({ ip: ip.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    .order('timestamp', { ascending: false }).limit(10);
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

// === 聊天 ===

function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - chinese;
  return chinese * 2 + Math.ceil(rest / 4);
}

async function callModel(model, systemPrompt, messages, maxTokens, extended_thinking) {
  if (model === 'deepseek' || model === 'deepseek-pro') {
    const modelName = model === 'deepseek-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
    const requestBody = {
      model: modelName,
      max_tokens: maxTokens || 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      thinking: { type: extended_thinking ? 'enabled' : 'disabled' }
    };
    const response = await deepseek.chat.completions.create(requestBody);
    const thinking = response.choices[0].message?.reasoning_content || '';
    return { text: response.choices[0].message.content, thinking };
  }

  const modelName = MODEL_MAP[model] || MODEL_MAP['opus'];
  const requestBody = {
    model: modelName,
    max_tokens: maxTokens || 4096,
    messages: [{ role: 'system', content: systemPrompt }, ...messages]
  };
  if (extended_thinking) {
    requestBody.reasoning = { effort: 'high' };
  }
  const response = await openrouter.chat.completions.create(requestBody);

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
        { role: 'system', content: prompt },
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

app.post('/api/chat', async (req, res) => {
  const { session_id, message, model, extended_thinking } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: 'missing fields' });

  const useModel = model || 'opus';

  try {
    await supabase.from('messages').insert({
      session_id, role: 'user', content: message, visible: true
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

    const fullSystem = systemPrompt + memoryContext;
    const chatMessages = history.map(m => ({ role: m.role, content: m.content }));
    const maxTokens = settings?.max_reply_tokens || 4096;

    const result = await callModel(useModel, fullSystem, chatMessages, maxTokens, extended_thinking);

    const { data: inserted } = await supabase.from('messages').insert({
      session_id, role: 'assistant', content: result.text, thinking: result.thinking || null, visible: true
    }).select().single();

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);
    await compressMemory(session_id, history, settings);

    res.json({ reply: result.text, thinking: result.thinking, model: useModel });

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

// === 游戏：你画我猜 ===

app.post('/api/games/draw-guess/start', async (req, res) => {
  try {
    const prompt = '你是一个"你画我猜"游戏的出题人。请随机想一个适合手绘涂鸦的具体名词(比如动物、日常物品、简单场景)，不要太抽象。只输出这个词本身，不要输出任何其他文字、标点或解释。';
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-v4-flash',
      max_tokens: 20,
      thinking: { type: 'disabled' },
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: '出一个题' }]
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
    const response = await openrouter.chat.completions.create({
      model: 'anthropic/claude-sonnet-4.6',
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

// === 启动 ===

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
