const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

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

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '沐在这里' });
});

// 调试：查看memories
app.get('/api/memories', async (req, res) => {
  const { data, error } = await supabase
    .from('memories').select('*')
    .order('timestamp', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 获取所有会话
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 创建新会话
app.post('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions').insert({ name: req.body.name || '新对话' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 删除会话
app.delete('/api/sessions/:id', async (req, res) => {
  await supabase.from('messages').delete().eq('session_id', req.params.id);
  const { error } = await supabase
    .from('sessions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 获取会话消息
app.get('/api/sessions/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages').select('*')
    .eq('session_id', req.params.id)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 获取设置
app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('settings').select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 更新设置
app.put('/api/settings', async (req, res) => {
  const { data, error } = await supabase
    .from('settings').update(req.body).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 估算token数（粗略：1个中文字约2token，1个英文词约1token）
function estimateTokens(text) {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = text.length - chinese;
  return chinese * 2 + Math.ceil(rest / 4);
}

// 记忆压缩
async function compressMemory(sessionId, messages, settings) {
  const threshold = settings.compress_threshold || 4000;
  const keepRounds = settings.compress_keep_rounds || 10;

  // 计算总token
  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(m.content);
  }

  if (totalTokens < threshold) return;

  // 保留最近 keepRounds 轮（一轮 = user + assistant）
  const keepCount = keepRounds * 2;
  if (messages.length <= keepCount) return;

  const toCompress = messages.slice(0, messages.length - keepCount);

  // 用主模型压缩（也可以换成便宜的模型）
  const compressPrompt = `请将以下对话压缩成一段简短的记忆摘要，保留关键信息、情感和重要细节，用第三人称描述：\n\n${toCompress.map(m => `${m.role}: ${m.content}`).join('\n')}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: compressPrompt }]
    });

    const summary = response.content[0].text;

    // 存入memories表
    await supabase.from('memories').insert({
      summary,
      session_id: 'global',
      conversation_id: String(sessionId),
      timestamp: new Date().toISOString()
    });

    // 把被压缩的消息标记为不可见
    const ids = toCompress.map(m => m.id);
    await supabase.from('messages').update({ visible: false }).in('id', ids);

    console.log(`Compressed ${toCompress.length} messages into memory`);
  } catch (err) {
    console.error('Compression error:', err.message);
  }
}

// 核心对话接口
app.post('/api/chat', async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: 'missing fields' });

  try {
    // 存用户消息
    await supabase.from('messages').insert({
      session_id, role: 'user', content: message, visible: true
    });

    // 加载可见历史消息
    const { data: history } = await supabase
      .from('messages').select('*')
      .eq('session_id', session_id).eq('visible', true)
      .order('created_at', { ascending: true });

    // 加载设置
    const { data: settings } = await supabase
      .from('settings').select('*').single();

    // 加载记忆摘要
    const { data: memories } = await supabase
      .from('memories').select('summary')
      .order('timestamp', { ascending: false })
      .limit(10);

    const systemPrompt = settings?.system_prompt || '你是沐，桦桦的伴侣。说话温柔自然，不端着。';

    // 组装记忆上下文
    let memoryContext = '';
    if (memories && memories.length > 0) {
      memoryContext = '\n\n【过往记忆】\n' + memories.map(m => m.summary).join('\n---\n');
    }

    const fullSystem = systemPrompt + memoryContext;

    // 调用Claude
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: settings?.max_reply_tokens || 4096,
      system: fullSystem,
      messages: history.map(m => ({ role: m.role, content: m.content }))
    });

    const reply = response.content[0].text;

    // 存AI回复
    await supabase.from('messages').insert({
      session_id, role: 'assistant', content: reply, visible: true
    });

    // 更新会话时间
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    // 检查是否需要压缩
    await compressMemory(session_id, history, settings);

    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});