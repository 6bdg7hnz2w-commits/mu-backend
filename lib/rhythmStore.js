// 打字节奏账本 —— fingertips (https://github.com/eveacla11/fingertips) 的JS/Supabase移植版
// 铁律不变：只记时间戳和删了几个字，永不记内容。状态存在 rhythm_state 表的单行（id=1）里。
// 只在跟她平时不一样的时候才出一个短标签，比如【节奏：慢，停了3次】；平时那样打的什么都不带。
// 标签什么意思写在沐的人设里（persona.md），这里不再每条都解释。

const PING_KEEP = 300;          // 最多保留的ping数（防止表行膨胀）
const ORPHAN_AFTER_SEC = 600;   // 打完多久没动静，算"欲言又止"
const ORPHAN_FRESH_SEC = 3 * 3600; // 太久以前的欲言又止就不提了
const PAUSE_GAP_SEC = 15;       // 两次ping间隔超过多少秒算一次"停顿"
const BASELINE_KEEP = 30;       // 拿她最近多少条当"平时"
const BASELINE_MIN = 8;         // 攒够这么多条才跟平时比，之前用固定门槛

async function loadState(supabase) {
  const { data, error } = await supabase
    .from('rhythm_state').select('pings, orphan, deleted, baseline').eq('id', 1).single();
  if (error) throw error;
  return {
    pings: data.pings || [],
    orphan: data.orphan || null,
    deleted: Number(data.deleted) || 0,
    baseline: Array.isArray(data.baseline) ? data.baseline : [],
  };
}

async function saveState(supabase, state) {
  const { error } = await supabase.from('rhythm_state').update({
    pings: state.pings,
    orphan: state.orphan,
    deleted: state.deleted,
    baseline: state.baseline,
    updated_at: new Date().toISOString()
  }).eq('id', 1);
  if (error) throw error;
}

// 一段打字搁置太久没发 → 沉为"欲言又止"的痕迹
function gc(state) {
  if (!state.pings.length) return;
  const last = state.pings[state.pings.length - 1];
  if (Date.now() - last > ORPHAN_AFTER_SEC * 1000) {
    const first = state.pings[0];
    if (last - first >= 5000) {   // 太短的不算，可能只是误触
      state.orphan = { start: first, end: last };
    }
    state.pings = [];
    state.deleted = 0;
  }
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 这一条和平时比：慢、停得多、删了又打。spc = 每个字花几秒，del = 删掉的字数 / 发出去的字数
function judge(sample, baseline) {
  const tags = [];
  if (baseline.length >= BASELINE_MIN) {
    if (sample.dur >= 20 && sample.spc >= 2 * median(baseline.map((b) => b.spc))) tags.push('慢');
    if (sample.pauses >= Math.max(2, median(baseline.map((b) => b.pauses)) + 2)) tags.push(`停了${sample.pauses}次`);
    if (sample.deleted >= 10 && sample.del >= Math.max(0.5, 2 * median(baseline.map((b) => b.del)))) tags.push('删了又打');
  } else {
    // 还不知道她平时什么样：只标明显的
    if (sample.dur >= 60 && sample.spc >= 3) tags.push('慢');
    if (sample.pauses >= 3) tags.push(`停了${sample.pauses}次`);
    if (sample.deleted >= 15 && sample.del >= 0.8) tags.push('删了又打');
  }
  return tags;
}

function makeRhythmStore(supabase) {
  return {
    // 前端打字探针每隔几秒调一次；deleted 是上次 ping 以来删掉了几个字（只有个数）
    async ping(deleted = 0) {
      const state = await loadState(supabase);
      gc(state);
      state.pings.push(Date.now());
      if (state.pings.length > PING_KEEP) state.pings = state.pings.slice(-PING_KEEP);
      const n = Number(deleted);
      if (Number.isFinite(n) && n > 0) state.deleted += Math.min(Math.floor(n), 10000);
      await saveState(supabase, state);
    },

    // 消息发出时调用：结算打字节奏，返回一个短标签（多数时候是空串）。length 是发出去的字数
    async popNote(length = 0) {
      const state = await loadState(supabase);
      gc(state);
      const tags = [];

      if (state.orphan) {
        if (Date.now() - state.orphan.end < ORPHAN_FRESH_SEC * 1000) tags.push('之前打了一段没发');
        state.orphan = null;
      }

      if (state.pings.length >= 2) {
        const dur = (state.pings[state.pings.length - 1] - state.pings[0]) / 1000;
        let pauses = 0;
        for (let i = 1; i < state.pings.length; i++) {
          if ((state.pings[i] - state.pings[i - 1]) / 1000 > PAUSE_GAP_SEC) pauses++;
        }
        const chars = Math.max(Number(length) || 0, 1);
        const sample = { dur, pauses, deleted: state.deleted, spc: dur / chars, del: state.deleted / chars };
        tags.push(...judge(sample, state.baseline));
        state.baseline = [...state.baseline, { spc: +sample.spc.toFixed(3), pauses, del: +sample.del.toFixed(3) }].slice(-BASELINE_KEEP);
      }
      state.pings = [];
      state.deleted = 0;

      await saveState(supabase, state);
      return tags.length ? `【节奏：${tags.join('，')}】` : '';
    }
  };
}

module.exports = { makeRhythmStore, judge };
