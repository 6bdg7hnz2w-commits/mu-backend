// 沐 (CC) 能收的文件类型。白名单只在 VPS 的 /opt/mu-bridge/file_types.json 里维护：
// bridge 的 GET /file-types 返回它，这里拉来缓存 5 分钟做校验，前端再从 /api/cc/file-types 拿去限制文件选择器。
// 加类型只改那一个 JSON（先实测沐用 Read 读得懂），这里和前端都不用动。
// 校验规则和 bridge 的 handleFileUpload 一致：扩展名在白名单 + 浏览器报的类型对得上 + 内容像（pdf 看文件头，文本不能有 NUL）。
// bridge 收到后还会再查一遍，这里先挡掉，免得白白把 20MB 传过去。
const CACHE_MS = 5 * 60 * 1000;
const GENERIC_MIME = new Set(['', 'application/octet-stream']);

let cache = null; // { at, value }

async function fetchFileTypes(bridge) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const r = await fetch(`${bridge.url}/file-types`, {
      headers: { 'Authorization': `Bearer ${bridge.token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    const raw = await r.json();
    const types = (Array.isArray(raw.types) ? raw.types : [])
      .filter(t => t && /^[a-z0-9]{1,10}$/.test(t.ext) && (t.kind === 'text' || t.kind === 'pdf'))
      .map(t => ({ ext: t.ext, kind: t.kind, mime: Array.isArray(t.mime) ? t.mime.map(String) : [] }));
    const value = { max_bytes: Number(raw.max_bytes) || 20 * 1024 * 1024, max_items: Number(raw.max_items) || 9, types };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    // bridge 一时连不上就先用上次的，别因为这个把上传全拒了
    if (cache) return cache.value;
    throw err;
  }
}

// 返回 null 表示通过，否则是给用户看的错误
function checkFile(types, { name, mime, buffer }) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const entry = types.types.find(t => t.ext === ext);
  if (!entry) return `不支持 .${ext || '?'} 文件`;
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!(GENERIC_MIME.has(m) || entry.mime.includes(m) || (entry.kind === 'text' && m.startsWith('text/')))) return `.${ext} 文件的类型不对（${m}）`;
  if (!buffer.length) return '文件是空的';
  if (entry.kind === 'pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return '文件内容不是 PDF';
  if (entry.kind === 'text' && buffer.includes(0)) return '文件内容不是文本';
  return null;
}

module.exports = { fetchFileTypes, checkFile };
