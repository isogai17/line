import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { fail } from './domain.js';

export async function createStore({ databaseUrl = '', sqlitePath = ':memory:' } = {}) {
  let db, pool;
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, max: 4,
      connectionTimeoutMillis: 12000, idleTimeoutMillis: 30000, statement_timeout: 15000 });
    pool.on('error', () => console.error('データベース接続が切れました。再接続を試みます。'));
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS money_entries (id TEXT PRIMARY KEY, data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      await pool.query('CREATE TABLE IF NOT EXISTS money_sessions (id TEXT PRIMARY KEY, auth_tag TEXT NOT NULL, expires_at BIGINT NOT NULL)');
    } catch (error) { await pool.end(); throw error; }
  } else {
    if (sqlitePath !== ':memory:') mkdirSync(dirname(sqlitePath), { recursive: true });
    db = new DatabaseSync(sqlitePath);
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS money_entries (id TEXT PRIMARY KEY, data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec('CREATE TABLE IF NOT EXISTS money_sessions (id TEXT PRIMARY KEY, auth_tag TEXT NOT NULL, expires_at BIGINT NOT NULL)');
  }
  async function run(sql, values = []) {
    if (pool) { let i = 0; return (await pool.query(sql.replace(/\?/g, () => '$' + (++i)), values)).rows; }
    return db.prepare(sql).all(...values);
  }
  const unpack = row => row && ({ ...JSON.parse(row.data), version: row.version, deleted: !!row.deleted, createdAt: row.created_at, updatedAt: row.updated_at });
  return {
    mode: pool ? 'cloud' : 'local',
    async createSession(id, authTag, expiresAt, time) {
      await run('DELETE FROM money_sessions WHERE expires_at <= ? RETURNING id', [time]);
      const count = await run('SELECT id FROM money_sessions');
      if (count.length >= 100) fail('ログイン端末が多すぎます。既存の端末でログアウトしてください。', 429);
      await run('INSERT INTO money_sessions (id,auth_tag,expires_at) VALUES (?,?,?) RETURNING id', [id, authTag, expiresAt]);
    },
    async hasSession(id, authTag, time) { return !!(await run('SELECT id FROM money_sessions WHERE id=? AND auth_tag=? AND expires_at>?', [id, authTag, time])).length; },
    async revokeSession(id) { await run('DELETE FROM money_sessions WHERE id=? RETURNING id', [id]); },
    async list({ deleted = false } = {}) { return (await run('SELECT * FROM money_entries WHERE deleted = ?', [deleted ? 1 : 0])).map(unpack).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); },
    async get(id) { return unpack((await run('SELECT * FROM money_entries WHERE id = ?', [id]))[0]); },
    async add(entry) {
      const time = new Date().toISOString();
      const inserted = await run('INSERT INTO money_entries (id,data,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *', [entry.id, JSON.stringify(entry), time, time]);
      if (inserted.length) return unpack(inserted[0]);
      const row = (await run('SELECT * FROM money_entries WHERE id = ?', [entry.id]))[0];
      if (row.deleted || JSON.stringify(entry) !== row.data) fail('この入力はすでに保存されている可能性があります。最新の記録を読み込んで内容を確認してください。', 409);
      return unpack(row);
    },
    async update(entry, version) {
      const rows = await run('UPDATE money_entries SET data=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted=0 RETURNING *', [JSON.stringify(entry), new Date().toISOString(), entry.id, version]);
      if (!rows.length) fail('別の端末で変更されています。最新の内容を読み込んでください。', 409);
      return unpack(rows[0]);
    },
    async remove(id, version, restore = false) {
      const rows = await run('UPDATE money_entries SET deleted=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted=? RETURNING *', [restore ? 0 : 1, new Date().toISOString(), id, version, restore ? 1 : 0]);
      if (!rows.length) fail('記録が変更されています。更新して確認してください。', 409);
      return unpack(rows[0]);
    },
    async close() { if (pool) await pool.end(); else db.close(); },
  };
}
