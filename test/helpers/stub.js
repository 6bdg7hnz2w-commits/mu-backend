// 测试桩（node -r 预加载）：假的 Supabase（每张表一个内存数组）、禁止出网。
// 只模拟鉴权测试用得到的那几种链式调用，不求和真库行为一致
const Module = require('module');

const tables = {};
let nextId = 1;
function builder(table) {
  const rows = (tables[table] ??= []);
  const st = { op: 'select', filters: [], payload: null };
  const match = (r) => st.filters.every(([k, v]) => String(r[k]) === String(v));
  const run = () => {
    if (st.op === 'insert') { const r = { id: nextId++, created_at: new Date().toISOString(), ...st.payload }; rows.push(r); return { data: [r], error: null }; }
    const hit = rows.filter(match);
    if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    if (st.op === 'delete') { hit.forEach((r) => rows.splice(rows.indexOf(r), 1)); return { data: hit, error: null }; }
    return { data: hit, error: null };
  };
  const b = {
    select: () => b, order: () => b, limit: () => b, range: () => b, neq: () => b, lt: () => b, lte: () => b, gte: () => b, or: () => b, is: () => b, in: () => b,
    eq: (k, v) => { st.filters.push([k, v]); return b; },
    insert: (p) => { st.op = 'insert'; st.payload = p; return b; },
    update: (p) => { st.op = 'update'; st.payload = p; return b; },
    delete: () => { st.op = 'delete'; return b; },
    single: () => { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: r.data.length ? null : { code: 'PGRST116', message: 'no rows' } }); },
    maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
    then: (res, rej) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}
const fake = { from: builder, storage: { from: () => ({}) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }) };

const load = Module._load;
Module._load = function (req, ...rest) {
  if (req === '@supabase/supabase-js') return { createClient: () => fake };
  return load.call(this, req, ...rest);
};
// STUB_ALLOW_FETCH 开头的地址放行（测试里起的假 bridge），别的一律禁止出网
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const allow = process.env.STUB_ALLOW_FETCH;
  if (allow && String(url).startsWith(allow)) return realFetch(url, ...rest);
  throw new Error('network disabled in tests');
};
