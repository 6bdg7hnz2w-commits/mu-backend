// 她发的图认字：bridge /ocr/pending 里还没认过的图交给官方 DeepSeek 的 deepseek-flash（看得懂图），
// 认出来的字和一句画面描述写回 bridge /ocr，查找聊天记录时就能搜到图里的字（原图 14 天后删了也搜得到）。
// 什么时候跑：起来 30 秒后一次、之后每 15 分钟一次（官方 App 发来的图不经过后端，靠这个兜住），她发了带图的消息马上一次。
// 2026-10-21 试过：1170×2532 的手机截图 40 行随机中文 + 数字全对；关掉思考一张约 3 秒、约 1000 输入 + 500 输出 token
const OCR_PROMPT = '这是聊天里发来的一张图。把图里所有能看清的文字原样逐字抄下来（保留换行，不翻译、不改写、不补全），再用一句中文描述画面。只回 JSON：{"text": "图里的文字，没有字就是空字符串", "caption": "一句话画面描述"}';
const BATCH = 20;
const MAX_PER_RUN = 200;
const MAX_FAILS = 3; // 同一张图这次进程里失败这么多次就不再试（解不开的 heic 之类）

function makeCcOcr({ bridgeFetch, env = process.env, log = console }) {
  const key = env.DEEPSEEK_API_KEY;
  const model = env.OCR_MODEL || 'deepseek-flash';
  const baseURL = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const fails = new Map(); // "<日期>/<文件>" → 失败次数
  const stats = { done: 0, failed: 0, last_error: '', last_run: null, pending: null };
  let running = null;

  async function recognize(buf, mime) {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, thinking: { type: 'disabled' }, max_tokens: 4000, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
          { type: 'text', text: OCR_PROMPT },
        ] }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`deepseek ${r.status}: ${String(data.error?.message || '').slice(0, 200)}`);
    const content = data.choices?.[0]?.message?.content || '';
    try {
      const j = JSON.parse(content);
      return { text: typeof j.text === 'string' ? j.text : '', caption: typeof j.caption === 'string' ? j.caption : '' };
    } catch {
      return { text: content, caption: '' }; // 没按 JSON 回就整段当图里的字
    }
  }

  async function one(rel) {
    const [date, file] = rel.split('/');
    const img = await bridgeFetch(`/uploads/${encodeURIComponent(date)}/${encodeURIComponent(file)}`, { raw: true, timeout: 30000 });
    if (!img.ok) throw new Error(`bridge uploads ${img.status}`);
    const mime = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const { text, caption } = await recognize(Buffer.from(await img.arrayBuffer()), mime);
    const w = await bridgeFetch('/ocr', { method: 'POST', body: { path: rel, text, caption, model } });
    if (!w.ok) throw new Error(`bridge /ocr ${w.status}`);
  }

  async function runOnce() {
    stats.last_run = new Date().toISOString();
    let tried = 0;
    while (tried < MAX_PER_RUN) {
      const p = await bridgeFetch(`/ocr/pending?limit=${Math.min(BATCH + fails.size, 100)}`);
      if (!p.ok) throw new Error(`bridge /ocr/pending ${p.status}`);
      stats.pending = p.data.total;
      const todo = (p.data.pending || []).filter(rel => (fails.get(rel) || 0) < MAX_FAILS).slice(0, BATCH);
      if (!todo.length) return;
      for (const rel of todo) {
        tried++;
        try {
          await one(rel);
          stats.done++;
          if (stats.pending > 0) stats.pending--;
        } catch (err) {
          fails.set(rel, (fails.get(rel) || 0) + 1);
          stats.failed++;
          stats.last_error = `${rel}: ${err.message}`.slice(0, 300);
          log.error('CC OCR error:', stats.last_error);
        }
      }
    }
  }

  // 正在跑就不重复开；没配 key 就什么都不做
  function kick() {
    if (!key) return Promise.resolve();
    if (!running) running = runOnce().catch(err => { stats.last_error = err.message.slice(0, 300); log.error('CC OCR run error:', err.message); }).finally(() => { running = null; });
    return running;
  }

  function start() {
    if (!key) { log.log('CC OCR: 没配 DEEPSEEK_API_KEY，图片不认字'); return; }
    setTimeout(kick, 30000).unref();
    setInterval(kick, 15 * 60 * 1000).unref();
  }

  const status = () => ({ configured: !!key, model, running: !!running, ...stats });
  return { kick, start, status };
}

module.exports = { makeCcOcr };
