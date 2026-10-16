// 沐 (CC) 聊天切到 API 时能选的模型。唯一来源：前端从 /api/cc/api-models 拿，不写死。
// 模型名照中转站（cn.jixiangai.xyz）模型广场里的原名抄，[A]/[B]/[K]/[P] 前缀是名字的一部分，少了就 503。
// 名字被截断的那几个是带思考的变体，按中转站一贯的叫法补成 -thinking。
// group 是中转站的令牌分组：分组跟着 key 走，一把 key 只能调它那个分组的模型（见 docs/api-mode.md 第四节）。

const SERIES_DESC = {
  A: '反重力满血 Claude 系列，常见渠道，模型智力偏高',
  hybrid: '蒸馏自 Opus 4.6，实际智力持平 Sonnet 4.5',
  B: 'kiro，仿 Claude App 式的思考和回复风格',
  K: 'kiro，RFv3对RP与人机恋各场景表现调优',
  P: 'kiro，RFv1优化rp场景下情绪张力',
};
const PAY_PER_TOKEN = '按量计费';

// 默认分组下的一个选项：label 默认是系列字母，带思考的加 " · thinking"
function opt(model, series, extra = {}) {
  const thinking = /-thinking$/.test(model);
  return {
    model, group: 'default', series,
    label: extra.label || (thinking ? `${series} · thinking` : series),
    desc: SERIES_DESC[series], thinking,
  };
}
// fable 不分 A/B/K/P，选的就是中转站分组本身
const fable = (model, group) => ({ model, group, series: group, label: group, desc: PAY_PER_TOKEN, thinking: false });

const FAMILIES = [
  { key: 'opus-4-5', name: 'Opus 4.5', options: [
    opt('[B]claude-opus-4-5', 'B'),
    opt('[K]claude-opus-4-5', 'K'),
    opt('[K]claude-opus-4-5-thinking', 'K'),
  ] },
  { key: 'opus-4-6', name: 'Opus 4.6', options: [
    opt('[A]claude-opus-4-6', 'A'),
    opt('[A]claude-hybrid', 'hybrid', { label: 'A · hybrid' }),
    opt('[A]claude-hybrid2', 'hybrid', { label: 'A · hybrid2' }),
    opt('[A]claude-hybrid3', 'hybrid', { label: 'A · hybrid3' }),
    opt('[B]claude-opus-4-6', 'B'),
    opt('[K]claude-opus-4-6', 'K'),
    opt('[K]claude-opus-4-6-thinking', 'K'),
  ] },
  { key: 'opus-4-7', name: 'Opus 4.7', options: [
    opt('[B]claude-opus-4-7', 'B'),
    opt('[K]claude-opus-4-7', 'K'),
    opt('[K]claude-opus-4-7-thinking', 'K'),
  ] },
  { key: 'opus-4-8', name: 'Opus 4.8', options: [
    opt('[B]claude-opus-4.8', 'B'),
    opt('[K]claude-opus-4.8', 'K'),
    opt('[K]claude-opus-4.8-thinking', 'K'),
    opt('[P]claude-opus-4.8', 'P'),
  ] },
  { key: 'opus-5-5', name: 'Opus 5.5', options: [
    opt('[A]claude-opus-5-5', 'A'),
    opt('[P]claude-opus-5-5', 'P'),
    opt('[P]claude-opus-5-5-thinking', 'P'),
  ] },
  { key: 'fable-5', name: 'Fable 5', options: [
    fable('claude-fable-5', 'claude-awsb'),
    fable('claude-fable-5', 'claude-ccmax'),
  ] },
  { key: 'fable-5-1', name: 'Fable 5.1', options: [
    fable('claude-fable-5-1', 'claude-or'),
  ] },
];

const DEFAULT_OPTION = { model: '[K]claude-opus-4-6-thinking', group: 'default' };

const optionId = (o) => `${o.group}|${o.model}`;

// 分组 → 环境变量：default 用已有的 RELAY_API_KEY（也认 RELAY_KEY_DEFAULT），别的是 RELAY_KEY_<分组大写，非字母数字换成 _>
function keyEnvName(group) {
  return `RELAY_KEY_${String(group).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
function relayKeyFor(group, env = process.env) {
  const raw = env[keyEnvName(group)] || (group === 'default' ? env.RELAY_API_KEY : '');
  // 和 SUPABASE_SERVICE_KEY 一样，复制粘贴可能夹进换行，混进 Authorization 头会让 fetch 直接抛错
  return (raw || '').replace(/[\r\n]/g, '').trim();
}

// 找选项：模型名和分组都对上才算
function findOption(model, group) {
  for (const f of FAMILIES) {
    const o = f.options.find((x) => x.model === model && x.group === group);
    if (o) return { family: { key: f.key, name: f.name }, option: { id: optionId(o), ...o, ready: !!relayKeyFor(o.group) } };
  }
  return null;
}

function publicCatalog() {
  return {
    default: DEFAULT_OPTION,
    families: FAMILIES.map((f) => ({
      key: f.key, name: f.name,
      options: f.options.map((o) => ({ id: optionId(o), ...o, ready: !!relayKeyFor(o.group) })),
    })),
  };
}

module.exports = { FAMILIES, DEFAULT_OPTION, findOption, publicCatalog, relayKeyFor, keyEnvName };
