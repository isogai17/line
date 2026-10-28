import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTは1〜65535で指定してください。');
  const host = env.HOST?.trim() || '127.0.0.1';
  const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const password = env.APP_PASSWORD || '';
  if (password && [...password].length < 12) throw new Error('APP_PASSWORDは12文字以上にしてください。');
  const raw = env.APP_ORIGIN?.trim() || env.RENDER_EXTERNAL_URL?.trim() || '';
  let origin = '';
  if (raw) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('APP_ORIGINのURLが正しくありません。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('APP_ORIGINはパスを含まないURLにしてください。');
    origin = url.origin;
  }
  if (!localOnly && (!password || !origin.startsWith('https://'))) throw new Error('公開時はAPP_PASSWORD（12文字以上）とAPP_ORIGIN（HTTPS）が必要です。');
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  if (databaseUrl) {
    let db;
    try { db = new URL(databaseUrl); } catch { throw new Error('DATABASE_URLを確認してください。'); }
    if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('DATABASE_URLはPostgreSQLの接続先を指定してください。');
  }
  return { port, host, localOnly, password, origin, databaseUrl,
    sqlitePath: localOnly ? resolve(env.SQLITE_PATH || 'data/budget.sqlite') : '',
    setupRequired: !localOnly && !databaseUrl };
}
