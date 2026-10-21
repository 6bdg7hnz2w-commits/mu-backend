// 图片认字（lib/ccOcr.js）：npm test
// 假 bridge（pending / uploads / ocr）+ 假 DeepSeek，看图怎么取、怎么交给模型、结果怎么写回、失败几次就不再试
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeCcOcr } = require('../lib/ccOcr');

let ds, dsUrl;
const asked = []; // 假 DeepSeek 收到的请求体
let reply = () => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ text: '电影票 7号厅', caption: '一张电影票' }) } }] } });

before(async () => {
  ds = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      asked.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const { status, body } = reply();
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => ds.listen(0, '127.0.0.1', r));
  dsUrl = `http://127.0.0.1:${ds.address().port}`;
});
after(() => ds?.close());

// 假 bridge：pending 里的图认完（写回 /ocr）就不再列
function fakeBridge(paths) {
  const done = new Map();
  const bridgeFetch = async (p, opts = {}) => {
    if (p.startsWith('/ocr/pending')) {
      const left = paths.filter((x) => !done.has(x));
      return { ok: true, status: 200, data: { pending: left.slice(0, Number(new URLSearchParams(p.split('?')[1]).get('limit'))), total: left.length } };
    }
    if (p.startsWith('/uploads/')) return new Response(Buffer.from('fake-jpg'), { status: 200, headers: { 'Content-Type': 'image/webp' } });
    if (p === '/ocr') { done.set(opts.body.path, opts.body); return { ok: true, status: 200, data: { ok: true } }; }
    throw new Error(`unexpected ${p}`);
  };
  return { bridgeFetch, done };
}
const quiet = { log() {}, error() {} };

test('认完写回 bridge：图按 data URL 交给 deepseek-flash、关掉思考、要 JSON', async () => {
  asked.length = 0;
  const b = fakeBridge(['2026-10-20/a.jpg', '2026-10-21/b.jpg']);
  const ocr = makeCcOcr({ bridgeFetch: b.bridgeFetch, env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: dsUrl }, log: quiet });
  await ocr.kick();
  assert.deepEqual([...b.done.keys()], ['2026-10-20/a.jpg', '2026-10-21/b.jpg']);
  assert.deepEqual(b.done.get('2026-10-20/a.jpg'), { path: '2026-10-20/a.jpg', text: '电影票 7号厅', caption: '一张电影票', model: 'deepseek-flash' });
  const req = asked[0];
  assert.equal(req.url, '/chat/completions');
  assert.equal(req.auth, 'Bearer k');
  assert.equal(req.body.model, 'deepseek-flash');
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.equal(req.body.response_format.type, 'json_object');
  assert.equal(req.body.messages[0].content[0].image_url.url, `data:image/webp;base64,${Buffer.from('fake-jpg').toString('base64')}`);
  assert.equal(ocr.status().done, 2);
  assert.equal(ocr.status().pending, 0);
});

test('模型没按 JSON 回：整段当图里的字', async () => {
  reply = () => ({ status: 200, body: { choices: [{ message: { content: '就是一些字' } }] } });
  const b = fakeBridge(['2026-10-20/c.jpg']);
  await makeCcOcr({ bridgeFetch: b.bridgeFetch, env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: dsUrl }, log: quiet }).kick();
  assert.equal(b.done.get('2026-10-20/c.jpg').text, '就是一些字');
  assert.equal(b.done.get('2026-10-20/c.jpg').caption, '');
});

test('一直失败的图试 3 次就不再试，不会死循环；记下最近的错', async () => {
  asked.length = 0;
  reply = () => ({ status: 400, body: { error: { message: 'unsupported image' } } });
  const b = fakeBridge(['2026-10-20/bad.heic']);
  const ocr = makeCcOcr({ bridgeFetch: b.bridgeFetch, env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_BASE_URL: dsUrl }, log: quiet });
  await ocr.kick();
  await ocr.kick();
  assert.equal(asked.length, 3);
  assert.equal(b.done.size, 0);
  assert.match(ocr.status().last_error, /bad\.heic: deepseek 400: unsupported image/);
});

test('没配 key：什么都不做', async () => {
  const b = fakeBridge(['2026-10-20/a.jpg']);
  const ocr = makeCcOcr({ bridgeFetch: b.bridgeFetch, env: {}, log: quiet });
  await ocr.kick();
  assert.equal(b.done.size, 0);
  assert.equal(ocr.status().configured, false);
});
