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
