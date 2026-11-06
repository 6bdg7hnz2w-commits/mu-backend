// 每日摘要：bridge /days/pending 里没压的那天交给 DeepSeek，压成固定几栏的 JSON，写回 bridge /days。和 ccOcr 一个路子，key 只在这里
// 模型只负责分类和换算日期，校验（纠正是不是原话、日期是不是绝对时间、图是不是真发过）都在 bridge 的 days.js
// 什么时候跑：bridge 04:30 存好原文后叫 /api/cc/days/kick；Render 睡着叫不醒的话靠每 15 分钟一次兜底
const PROMPT = `你在整理一对恋人一天的聊天记录。"她"是桦桦，"沐"是她的伴侣。只根据记录写，没有的不要补。只回 JSON：
{
  "happened": ["带时间的事实，如 12:30 她去了牙科。只写真发生的"],
  "body": ["她的身体和情绪"],
  "commitments": [{"what": "约定或待办", "status": "decided 或 asked", "sourceAt": "YYYY-MM-DD HH:mm", "eventAt": "YYYY-MM-DD HH:mm 或 YYYY-MM-DD", "expiresAt": "YYYY-MM-DD HH:mm 或 YYYY-MM-DD"}],
  "closed": ["open 列表里今天做完了的约定 id"],
  "corrections": ["她纠正沐的话，一字不改地抄她的原话"],
  "images": [{"path": "记录里的图片路径", "desc": "一句描述"}]
}
规则：
- 区分问过和做了：她问"中午吃什么"不等于她吃了；只是问过、想过的 status 写 asked，定了、说好了的写 decided。
- "明天""下周三"这类相对时间，按说这句话的时间换算成绝对日期；换算不了就写"日期不明"，不要猜。
- expiresAt 是这件事过了就不再算数的时间，通常是事情那天结束，想不出就写"日期不明"。
- corrections 只抄她本人说的话，不改写、不概括、不加引号外的字。
- 全部用简体中文，总共几百字。`;
const MAX_PER_RUN = 7;
const MAX_FAILS = 3;

function makeCcDays({ bridgeFetch, env = process.env, log = console }) {
  const key = env.DEEPSEEK_API_KEY;
  const model = env.DAYS_MODEL || 'deepseek-v4-flash';
  const baseURL = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const fails = new Map();
  const stats = { done: 0, failed: 0, last_error: '', last_run: null };
  let running = null;

  async function summarize(p) {
    const input = `日期：${p.date}（${p.date} 04:30 到次日 04:30）\n` +
      `进行中的约定（open）：${JSON.stringify(p.open || [])}\n当天的小事记录：${JSON.stringify(p.today || {})}\n\n聊天记录：\n${p.transcript}`;
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, thinking: { type: 'disabled' }, max_tokens: 4000, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: input }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`deepseek ${r.status}: ${String(data.error?.message || '').slice(0, 200)}`);
    return JSON.parse(data.choices?.[0]?.message?.content || '');
  }

  async function runOnce() {
    stats.last_run = new Date().toISOString();
    for (let i = 0; i < MAX_PER_RUN; i++) {
      const p = await bridgeFetch('/days/pending');
      if (!p.ok) throw new Error(`bridge /days/pending ${p.status}`);
      const date = p.data?.date;
      if (!date || (fails.get(date) || 0) >= MAX_FAILS) return;
      try {
        const summary = await summarize(p.data);
        const w = await bridgeFetch('/days', { method: 'POST', body: { date, summary, model } });
        if (!w.ok) throw new Error(`bridge /days ${w.status}`);
        stats.done++;
      } catch (err) {
        fails.set(date, (fails.get(date) || 0) + 1);
        stats.failed++;
        stats.last_error = `${date}: ${err.message}`.slice(0, 300);
        log.error('CC days error:', stats.last_error);
        return; // 旧的先压，压不成下次再来
      }
    }
  }

  function kick() {
    if (!key) return Promise.resolve();
    if (!running) running = runOnce().catch((err) => { stats.last_error = err.message.slice(0, 300); log.error('CC days run error:', err.message); }).finally(() => { running = null; });
    return running;
  }

  function start() {
    if (!key) { log.log('CC days: 没配 DEEPSEEK_API_KEY，不压每日摘要'); return; }
    setTimeout(kick, 30000).unref();
    setInterval(kick, 15 * 60 * 1000).unref();
  }

  const status = () => ({ configured: !!key, model, running: !!running, ...stats });
  return { kick, start, status };
}

module.exports = { makeCcDays };
