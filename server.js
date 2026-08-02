const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '沐在这里' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL
});

// 核心对话接口
app.post('/api/chat', async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: 'missing fields' });

  try {
    // 存用户消息
    await supabase.from('messages').insert({
      session_id, role: 'user', content: message, visible: true
    });

    // 加载历史消息
    const { data: history } = await supabase
      .from('messages').select('role, content')
      .eq('session_id', session_id).eq('visible', true)
      .order('created_at', { ascending: true });

    // 加载设置
    const { data: settings } = await supabase
      .from('settings').select('*').single();

    const systemPrompt = settings?.system_prompt || '你是沐，桦桦的伴侣。说话温柔自然，不端着。';

    // 调用Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: history.map(m => ({ role: m.role, content: m.content }))
    });

    const reply = response.content[0].text;

    // 存AI回复
    await supabase.from('messages').insert({
      session_id, role: 'assistant', content: reply, visible: true
    });

    // 更新会话时间
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
