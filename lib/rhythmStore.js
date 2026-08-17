// 打字节奏账本 —— fingertips (https://github.com/eveacla11/fingertips) 的JS/Supabase移植版
// 铁律不变：只记时间戳，永不记内容。状态存在 rhythm_state 表的单行（id=1）里。

const PING_KEEP = 300;          // 最多保留的ping数（防止表行膨胀）
const ORPHAN_AFTER_SEC = 600;   // 打完多久没动静，算"欲言又止"
const MIN_NOTE_SEC = 20;        // 打字超过多少秒才值得告诉AI
const PAUSE_GAP_SEC = 15;       // 两次ping间隔超过多少秒算一次"停顿"

async function loadState(supabase) {
  const { data, error } = await supabase
    .from('rhythm_state').select('pings, orphan').eq('id', 1).single();
  if (error) throw error;
  return { pings: data.pings || [], orphan: data.orphan || null };
}

async function saveState(supabase, state) {
  const { error } = await supabase.from('rhythm_state').update({
    pings: state.pings,
    orphan: state.orphan,
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
  }
}

function makeRhythmStore(supabase) {
  return {
    // 前端打字探针每隔几秒调一次
    async ping() {
      const state = await loadState(supabase);
      gc(state);
      state.pings.push(Date.now());
      if (state.pings.length > PING_KEEP) state.pings = state.pings.slice(-PING_KEEP);
      await saveState(supabase, state);
    },

    // 消息发出时调用：结算打字节奏，返回给AI看的一句话（多数时候为空串）
    async popNote() {
      const state = await loadState(supabase);
      gc(state);
      const notes = [];

      if (state.orphan) {
        const mins = Math.floor((Date.now() - state.orphan.end) / 60000);
        const dur = Math.floor((state.orphan.end - state.orphan.start) / 1000);
        notes.push(`TA ${mins}分钟前打过${dur}秒的字，那条没有发出来（打了什么无人知晓，包括系统）`);
        state.orphan = null;
      }

      if (state.pings.length) {
        const dur = Math.floor((state.pings[state.pings.length - 1] - state.pings[0]) / 1000);
        let gaps = 0;
        for (let i = 1; i < state.pings.length; i++) {
          if ((state.pings[i] - state.pings[i - 1]) / 1000 > PAUSE_GAP_SEC) gaps++;
        }
        if (dur >= MIN_NOTE_SEC || gaps) {
          let seg = `这条消息TA打了${dur}秒`;
          if (gaps) seg += `，中途停下来想了${gaps}次`;
          notes.push(seg);
        }
        state.pings = [];
      }

      await saveState(supabase, state);
      return notes.join('；');
    },

    // 意识循环用：只看不消费
    async peekOrphan() {
      const state = await loadState(supabase);
      gc(state);
      await saveState(supabase, state);
      return state.orphan ? { ...state.orphan } : null;
    },

    // 意识循环处理完欲言又止后调用，避免下一轮cron重复提起
    async consumeOrphan() {
      const state = await loadState(supabase);
      const orphan = state.orphan;
      state.orphan = null;
      await saveState(supabase, state);
      return orphan;
    }
  };
}

module.exports = { makeRhythmStore };
