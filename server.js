```javascript
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL
});

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '沐在这里' });
});

app.get('/api/memories', async (req, res) => {
  const { data, error } = await supabase
    .from('memories').select('*')
    .order('timestamp', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').insert({ name: req.body.name || '新对话' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/sessions/:id', async (req, res) => {
  await supabase.from('messages').delete().eq('session_id', req.params.id);
  const { error } = await supabase
    .from('sessions').delete().eq('id', req.params.id);
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

app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('settings').select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('settings').update(req.body).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - chinese;
  return chinese * 2 + Math.ceil(rest / 4);
}

async function callDeepSeek(systemPrompt, messages, maxTokens) {
  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    max_tokens: maxTokens || 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ]
  });
  return response.choices[0].message.content;
}

async function callClaude(model, systemPrompt, messages, maxTokens) {
  const modelName = model === 'sonnet' ? 'claude-sonnet-4-20250514' : 'claude-opus-4-20250514';
  const response = await anthropic.messages.create({
    model: modelName,
    max_tokens: maxTokens || 4096,
    system: systemPrompt,
    messages
  });
  return response.content[0].text;
}

async function compressMemory(sessionId, messages, settings) {
  const threshold = settings.compress_threshold || 4000;
  const keepRounds = settings.compress_keep_rounds || 10;

  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(m.content);
  }

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
    const summary = await callDeepSeek(compressPrompt, compressMessages, 1024);

    await supabase.from('memories').insert({
      summary,
      session_id: 'global',
      conversation_id: String(sessionId),
      timestamp: new Date().toISOString()
    });

    const ids = toCompress.map(m => m.id);
    await supabase.from('messages').update({ visible: false }).in('id', ids);

    console.log('Compressed ' + toCompress.length + ' messages into memory');
  } catch (err) {
    console.error('Compression error:', err.message);
  }
}

app.post('/api/chat', async (req, res) => {
  const { session_id, message, model } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: 'missing fields' });

  var useModel = model || 'opus';

  try {
    await supabase.from('messages').insert({
      session_id, role: 'user', content: message, visible: true
    });

    const { data: history } = await supabase
      .from('messages').select('*')
      .eq('session_id', session_id).eq('visible', true)
      .order('created_at', { ascending: true });

    const { data: settings } = await supabase
      .from('settings').select('*').single();

    const { data: memories } = await supabase
      .from('memories').select('summary')
      .order('timestamp', { ascending: false })
      .limit(10);

    const systemPrompt = settings?.system_prompt || '你是沐，桦桦的伴侣。说话温柔自然，不端着。';

    var memoryContext = '';
    if (memories && memories.length > 0) {
      memoryContext = '\n\n【过往记忆】\n' + memories.map(m => m.summary).join('\n---\n');
    }

    const fullSystem = systemPrompt + memoryContext;
    const chatMessages = history.map(m => ({ role: m.role, content: m.content }));
    const maxTokens = settings?.max_reply_tokens || 4096;

    var reply;
    if (useModel === 'deepseek') {
      reply = await callDeepSeek(fullSystem, chatMessages, maxTokens);
    } else {
      reply = await callClaude(useModel, fullSystem, chatMessages, maxTokens);
    }

    await supabase.from('messages').insert({
      session_id, role: 'assistant', content: reply, visible: true
    });

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    await compressMemory(session_id, history, settings);

    res.json({ reply, model: useModel });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
```
