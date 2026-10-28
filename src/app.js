import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CATEGORIES, PURPOSES, validateEntry, summarize, fail, entryHash } from './domain.js';
import { toCSV, toXLSX, parseImport } from './files.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']], ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
]);
const hash = v => createHash('sha256').update(v).digest();
const lifetime = 7 * 24 * 60 * 60 * 1000;
function send(res, status, value) { if (res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function readJson(req, limit = 32768) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('JSON形式で送信してください。', 415);
  const raw = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0, rejected = false;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { if (!rejected) { rejected = true; chunks.length = 0; const error = new Error('送信サイズが大きすぎます。'); error.status = 413; reject(error); } } else if (!rejected) chunks.push(chunk); });
    req.once('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); }); req.once('error', reject); req.once('aborted', () => reject(new Error('ABORTED')));
  });
  try { return JSON.parse(raw.toString('utf8')); } catch { fail('入力を読み取れませんでした。'); }
}
export function createApp({ store = null, password = '', origin = '', localOnly = true, now = Date.now, logger = console } = {}) {
  const sessions = new Map(); const passwordHash = hash(password); let loginTimes = [], writeTimes = []; let busyImport = false, busyCommit = false;
  const authTag = createHmac('sha256', passwordHash).update('money-auth-v1').digest('hex');
  const token = req => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('money_session='))?.slice(14);
  async function authenticated(req) {
    if (!password) return true;
    const t = token(req); if (!t || !/^[\w-]{43}$/.test(t)) return false;
    if (store) return store.hasSession(hash(t).toString('hex'), authTag, now());
    for (const [t, exp] of sessions) if (exp <= now()) sessions.delete(t);
    return sessions.has(t);
  }
  function cookie(res, value, maxAge = lifetime / 1000) { res.setHeader('set-cookie', `money_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin.startsWith('https://') ? '; Secure' : ''}`); }
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (origin.startsWith('https://')) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const url = new URL(req.url, `http://${req.headers.host}`); const path = url.pathname;
      if (localOnly && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return send(res, 403, { error: '接続先が許可されていません。' });
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok', application: 'money-book' });
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path); const body = await readFile(new URL('../public/' + file, import.meta.url));
        res.writeHead(200, { 'content-type': type }); return res.end(body);
      }
      if (req.method === 'GET' && path === '/api/config') return send(res, 200, {
        authenticated: await authenticated(req), authRequired: !!password, ready: !!store, storage: store?.mode || 'unconfigured', categories: CATEGORIES, purposes: PURPOSES,
      });
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, { error: 'この操作には対応していません。' });
      if (req.method !== 'GET') {
        if (req.headers.origin !== (origin || url.origin) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) return send(res, 403, { error: 'アプリの画面から操作してください。' });
      }
      if (req.method === 'POST' && path === '/api/login') {
        loginTimes = loginTimes.filter(t => t > now() - 60000);
        if (loginTimes.length >= 10) { res.setHeader('retry-after', '60'); return send(res, 429, { error: '1分待ってからもう一度お試しください。' }); }
        const data = await readJson(req); loginTimes.push(now());
        if (password && (typeof data?.password !== 'string' || !timingSafeEqual(hash(data.password), passwordHash))) return send(res, 401, { error: 'パスワードが違います。' });
        const t = randomBytes(32).toString('base64url');
        while (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        if (store) await store.createSession(hash(t).toString('hex'), authTag, now() + lifetime, now());
        else sessions.set(t, now() + lifetime);
        cookie(res, t); return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/logout') { const t = token(req); if (t && store) await store.revokeSession(hash(t).toString('hex')); sessions.delete(t); cookie(res, '', 0); return send(res, 200, { ok: true }); }
      if (!path.startsWith('/api/')) return send(res, 404, { error: 'ページがありません。' });
      if (!await authenticated(req)) return send(res, 401, { error: 'ログインしてください。' });
      if (!store) return send(res, 503, { error: 'クラウド保存先が未設定です。RenderのDATABASE_URLを設定してください。記録はまだ保存されません。' });
      if (req.method !== 'GET') {
        writeTimes = writeTimes.filter(t => t > now() - 60000);
        if (writeTimes.length >= 120) return send(res, 429, { error: '操作が多いため少し待ってください。' });
        writeTimes.push(now());
      }
      if (req.method === 'GET' && path === '/api/entries') return send(res, 200, { entries: await store.list({ deleted: url.searchParams.get('trash') === '1' }) });
      if (req.method === 'GET' && path === '/api/summary') {
        const month = url.searchParams.get('month'); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) fail('対象月を選んでください。');
        return send(res, 200, summarize(await store.list(), month));
      }
      if (req.method === 'POST' && path === '/api/entries') { const entry = validateEntry(await readJson(req)); return send(res, 201, { entry: await store.add(entry) }); }
      const match = path.match(/^\/api\/entries\/([\w-]{8,100})(\/restore)?$/);
      if (match && ['PUT', 'DELETE', 'POST'].includes(req.method)) {
        const data = await readJson(req); if (!Number.isInteger(data?.version) || data.version < 1) fail('最新の記録を読み込んでください。');
        if (req.method === 'PUT' && !match[2]) return send(res, 200, { entry: await store.update(validateEntry(data, { id: match[1] }), data.version) });
        if (req.method === 'DELETE' && !match[2]) return send(res, 200, { entry: await store.remove(match[1], data.version) });
        if (req.method === 'POST' && match[2]) return send(res, 200, { entry: await store.remove(match[1], data.version, true) });
      }
      if (req.method === 'POST' && path === '/api/import/preview') {
        if (busyImport) return send(res, 429, { error: '読み取り中です。少し待ってください。' });
        busyImport = true;
        try {
          const candidates = await parseImport(await readJson(req, 14 * 1024 * 1024));
          const existing = await store.list(); const hashes = new Set(existing.map(entryHash)), sources = new Set(existing.filter(e => e.sourceKey).map(e => e.sourceKey));
          return send(res, 200, { candidates: candidates.map(e => ({ ...e, id: randomUUID(), duplicate: (e.sourceKey && sources.has(e.sourceKey)) || (!e.error && hashes.has(entryHash(e))) || false })) });
        } finally { busyImport = false; }
      }
      if (req.method === 'POST' && path === '/api/import/commit') {
        if (busyCommit) return send(res, 429, { error: '別の取込を保存中です。完了後にもう一度お試しください。' });
        busyCommit = true;
        try {
        const data = await readJson(req, 1024 * 1024);
        if (!Array.isArray(data?.entries) || !data.entries.length || data.entries.length > 500) fail('1〜500件を選んでください。');
        const entries = data.entries.map(e => validateEntry(e));
        // 全行の入力検証が終わってから保存。途中失敗時は保存済み件数を明示する。
        const existing = await store.list(); const hashes = new Set(existing.map(entryHash)), sources = new Set(existing.filter(e => e.sourceKey).map(e => e.sourceKey));
        let added = 0, skipped = 0;
        for (const entry of entries) {
          const key = entryHash(entry);
          if (hashes.has(key) || (entry.sourceKey && sources.has(entry.sourceKey))) { skipped++; continue; }
          try { await store.add(entry); } catch { return send(res, 503, { error: `${added}件を保存した後に接続が切れました。再読み込みしてから同じ取込を再実行してください。重複は除外されます。` }); }
          added++; hashes.add(key); if (entry.sourceKey) sources.add(entry.sourceKey);
        }
        return send(res, 200, { added, skipped });
        } finally { busyCommit = false; }
      }
      if (req.method === 'GET' && path === '/api/export') {
        const year = Number(url.searchParams.get('year'));
        if (!Number.isInteger(year) || year < 1900 || year > 2199) fail('出力する年を選んでください。');
        const format = url.searchParams.get('format'); const all = await store.list(); const entries = all.filter(e => e.date.startsWith(`${year}-`));
        let body, type;
        if (format === 'csv') { body = toCSV(entries); type = 'text/csv; charset=utf-8'; }
        else if (format === 'xlsx') { body = await toXLSX(entries, year); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
        else if (format === 'json') { body = JSON.stringify({ app: 'my-money-book', version: 1, exportedAt: new Date().toISOString(), entries: all }, null, 2); type = 'application/json'; }
        else fail('CSV、Excel、JSONのいずれかを選んでください。');
        res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="budget-${format === 'json' ? 'all-years' : year}.${format}"` }); return res.end(body);
      }
      return send(res, 404, { error: 'ページがありません。' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error.status) return send(res, error.status, { error: error.message });
      logger.error('家計簿の処理に失敗しました。接続と入力形式を確認してください。');
      return send(res, 503, { error: '処理できませんでした。接続状態やファイル形式を確認し、再試行してください。入力内容は保存完了まで消さないでください。' });
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  return { server };
}
