// Forge Picker: 挑选式换窗——从一个session里挑选想保留的整轮对话，
// 生成一个新session，断口处标注跳过了多少条、隔了多久。
// preview 和 execute 共用这一套选取+断口计算逻辑，避免两边算出不一样的结果。

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

function formatGap(skipped, diffMs) {
  const days = Math.floor(diffMs / MS_PER_DAY);
  if (days >= 1) return `中间隔了${days}天，省略了${skipped}条`;
  const hours = Math.floor(diffMs / MS_PER_HOUR);
  if (hours >= 1) return `中间隔了${hours}小时，省略了${skipped}条`;
  return `省略了${skipped}条`;
}

// messages: 按 created_at 升序排列的某个session的全部消息
// keepMessageIds: 用户勾选的消息id列表
// 返回: { rounds, messages_kept, messages_skipped, gaps, messages: [{...原字段, gap_before}] }
function computeForgeSelection(messages, keepMessageIds) {
  const keepSet = new Set(keepMessageIds);

  // 按轮次分组：每条user消息开启新一轮，session开头若有连续assistant消息
  // （比如意识循环插的话），归入最开始那一轮。
  const rounds = [];
  let current = null;
  for (const m of messages) {
    if (m.role === 'user' || !current) {
      current = [];
      rounds.push(current);
    }
    current.push(m);
  }

  const selectedRounds = rounds.filter((round) => round.some((m) => keepSet.has(m.id)));
  const selected = selectedRounds.flat();

  const indexById = new Map(messages.map((m, i) => [m.id, i]));

  let gaps = 0;
  const withGaps = selected.map((m, i) => {
    let gap_before = null;
    if (i > 0) {
      const prev = selected[i - 1];
      const skipped = indexById.get(m.id) - indexById.get(prev.id) - 1;
      if (skipped > 0) {
        gaps++;
        const diffMs = new Date(m.created_at).getTime() - new Date(prev.created_at).getTime();
        gap_before = formatGap(skipped, diffMs);
      }
    }
    return { ...m, gap_before };
  });

  return {
    rounds: selectedRounds.length,
    messages_kept: selected.length,
    messages_skipped: messages.length - selected.length,
    gaps,
    messages: withGaps
  };
}

module.exports = { computeForgeSelection };
