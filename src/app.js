import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_INPUT_LENGTH, TONES, validateDrafts } from './replies.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const sessionLifetime = 12 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest();

function send(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    const error = new Error('JSON形式で送信してください。');
    error.status = 415;
    throw error;
  }
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          const error = new Error('送信内容が大きすぎます。文章を短くしてください。');
          error.status = 413;
          reject(error);
        }
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.once('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('REQUEST_ABORTED')));
  });
  return JSON.parse(raw.toString('utf8'));
}

// 一人または少人数向け。セッションと回数制限はメモリ内で管理する。
export function createApp({ generator, demo = false, password = '', origin = '', localOnly = true, logger = console,
  now = Date.now, generationLimit = 20, maxConcurrent = 2 }) {
  const sessions = new Map();
  const passwordHash = hash(password);
  let active = 0;
  let generationTimes = [];
  let loginTimes = [];

  function sessionToken(req) {
    return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('draft_session='))?.slice('draft_session='.length);
  }
  function authenticated(req) {
    if (!password) return true;
    const time = now();
    for (const [token, expires] of sessions) if (expires <= time) sessions.delete(token);
    return sessions.has(sessionToken(req));
  }
  function setSessionCookie(res, token, maxAge = sessionLifetime / 1000) {
    res.setHeader('set-cookie', `draft_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin.startsWith('https://') ? '; Secure' : ''}`);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const requestURL = new URL(req.url, `http://${req.headers.host}`);
      // ローカル利用時のDNSリバインディングを防ぐ。
      if (localOnly && !['localhost', '127.0.0.1', '[::1]'].includes(requestURL.hostname)) return send(res, 403, { error: '許可されていない接続先です。' });
      const path = requestURL.pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok', mode: demo ? 'sample' : 'ai' });
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const body = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'content-type': type });
        return res.end(body);
      }
      if (req.method === 'GET' && path === '/api/config') {
        return send(res, 200, { mode: demo ? 'sample' : 'ai', authRequired: !!password, authenticated: authenticated(req), maxInputLength: MAX_INPUT_LENGTH });
      }
      if (req.method !== 'POST' || !['/api/login', '/api/logout', '/api/replies'].includes(path)) {
        return send(res, 404, { error: 'ページが見つかりません。' });
      }
      const expectedOrigin = origin || requestURL.origin;
      if (req.headers.origin !== expectedOrigin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        return send(res, 403, { error: 'アプリの画面から操作してください。' });
      }
      if (path === '/api/login') {
        if (!password) return send(res, 200, { ok: true });
        loginTimes = loginTimes.filter((time) => time > now() - 60_000);
        if (loginTimes.length >= 10) {
          res.setHeader('retry-after', '60');
          return send(res, 429, { error: '試行回数が多いため、1分ほど待ってからお試しください。' });
        }
        loginTimes.push(now());
        const data = await readJson(req);
        if (typeof data?.password !== 'string' || !timingSafeEqual(hash(data.password), passwordHash)) return send(res, 401, { error: 'パスワードが違います。' });
        const token = randomBytes(32).toString('base64url');
        authenticated(req);
        while (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        sessions.set(token, now() + sessionLifetime);
        setSessionCookie(res, token);
        return send(res, 200, { ok: true });
      }
      if (path === '/api/logout') {
        sessions.delete(sessionToken(req));
        setSessionCookie(res, '', 0);
        return send(res, 200, { ok: true });
      }
      if (!authenticated(req)) return send(res, 401, { error: '利用するにはログインしてください。' });
      const data = await readJson(req);
      if (typeof data?.message !== 'string' || !data.message.trim() || [...data.message.trim()].length > MAX_INPUT_LENGTH) {
        return send(res, 400, { error: `1〜${MAX_INPUT_LENGTH}文字の文章を入力してください。` });
      }
      const tone = data.tone ?? 'natural';
      if (typeof tone !== 'string' || !Object.hasOwn(TONES, tone)) return send(res, 400, { error: '返信の雰囲気を選んでください。' });
      if (active >= maxConcurrent) return send(res, 503, { error: 'ただいま処理が混み合っています。少し待ってからお試しください。' });
      generationTimes = generationTimes.filter((time) => time > now() - 60_000);
      if (generationTimes.length >= generationLimit) {
        res.setHeader('retry-after', '60');
        return send(res, 429, { error: '利用回数の上限です。1分ほど待ってからお試しください。' });
      }
      generationTimes.push(now());
      active++;
      const controller = new AbortController();
      const disconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnect);
      try {
        const result = validateDrafts(await generator({ message: data.message.trim(), tone, signal: controller.signal }));
        return send(res, 200, { ...result, sample: demo });
      } catch (error) {
        if (controller.signal.aborted) return;
        logger.error('返信案の生成に失敗しました。');
        const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
        return send(res, timedOut ? 504 : 502, { error: timedOut
          ? '返信案の作成に時間がかかっています。もう一度お試しください。'
          : '今は返信案を作成できません。時間をおいて再度お試しください。続く場合は管理者がAIの接続設定・利用上限を確認してください。' });
      } finally {
        active--;
        res.removeListener('close', disconnect);
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error.status) return send(res, error.status, { error: error.message });
      if (error instanceof SyntaxError) return send(res, 400, { error: '送信内容を読み取れませんでした。' });
      logger.error('HTTPリクエストの処理に失敗しました。');
      return send(res, 500, { error: '処理に失敗しました。もう一度お試しください。' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server };
}
