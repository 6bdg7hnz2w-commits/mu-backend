// 打字节奏的门槛：npm test
// 只在跟她平时不一样的时候才出标签；平时那样打的什么都不带
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeRhythmStore, judge } = require('../lib/rhythmStore');

// 平时：每个字 1 秒左右，停 0~1 次，几乎不删
const usual = Array.from({ length: 10 }, (_, i) => ({ spc: 0.9 + (i % 3) * 0.1, pauses: i % 2, del: 0.05 }));

test('跟平时差不多 → 不带标签', () => {
  assert.deepEqual(judge({ dur: 40, spc: 1.1, pauses: 1, deleted: 3, del: 0.08 }, usual), []);
});

test('比平时慢一倍以上、停得多、删得多 → 都标上', () => {
  assert.deepEqual(judge({ dur: 90, spc: 3, pauses: 4, deleted: 30, del: 1 }, usual), ['慢', '停了4次', '删了又打']);
});

test('门槛：不到一分钟不算慢，停不到 4 次、删不到 30 个字也不标', () => {
  assert.deepEqual(judge({ dur: 50, spc: 6, pauses: 3, deleted: 29, del: 2 }, usual), []);
});

test('平时就停得多的人，停 3 次不算反常', () => {
  const pausy = usual.map((b) => ({ ...b, pauses: 3 }));
  assert.deepEqual(judge({ dur: 40, spc: 1, pauses: 3, deleted: 0, del: 0 }, pausy), []);
  assert.deepEqual(judge({ dur: 40, spc: 1, pauses: 5, deleted: 0, del: 0 }, pausy), ['停了5次']);
  const pausier = usual.map((b) => ({ ...b, pauses: 4 }));
  assert.deepEqual(judge({ dur: 40, spc: 1, pauses: 5, deleted: 0, del: 0 }, pausier), []);
});

test('还没攒够平时的样子：只标很明显的', () => {
  assert.deepEqual(judge({ dur: 40, spc: 2, pauses: 3, deleted: 25, del: 0.9 }, []), []);
  assert.deepEqual(judge({ dur: 80, spc: 4, pauses: 4, deleted: 30, del: 1 }, []), ['慢', '停了4次', '删了又打']);
});

// 假的 rhythm_state 单行
function fakeDb(row) {
  return {
    row,
    from() {
      const db = this;
      const b = {
        select: () => b, eq: () => b,
        single: () => Promise.resolve({ data: { ...db.row }, error: null }),
        update: (p) => ({ eq: () => { Object.assign(db.row, p); return Promise.resolve({ error: null }); } }),
      };
      return b;
    },
  };
}

test('popNote：攒删字数、出标签、记进平时、清空', async () => {
  const now = Date.now();
  const db = fakeDb({ pings: [now - 120000, now - 90000, now - 60000, now - 30000, now - 1000], orphan: null, deleted: 40, baseline: usual });
  const store = makeRhythmStore(db);
  const note = await store.popNote(20); // 119 秒打 20 个字，停了 4 次（每次 30 秒），删了 40 个
  assert.equal(note, '【节奏：慢，停了4次，删了又打】');
  assert.equal(db.row.pings.length, 0);
  assert.equal(db.row.deleted, 0);
  assert.equal(db.row.baseline.length, 11);
});

test('popNote：平时那样打的返回空串；ping 累加删掉的字数', async () => {
  const now = Date.now();
  const db = fakeDb({ pings: [now - 20000, now - 12000, now - 4000], orphan: null, deleted: 0, baseline: usual });
  const store = makeRhythmStore(db);
  await store.ping(2);
  assert.equal(db.row.deleted, 2);
  assert.equal(await store.popNote(20), '');
});
