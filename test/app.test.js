import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import ExcelJS from 'exceljs';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { validateEntry, summarize, validDate } from '../src/domain.js';
import { parseCSV, parseImport, textCandidates, toCSV, toXLSX } from '../src/files.js';

const sample = (extra = {}) => ({ id: randomUUID(), date: '2026-10-28', type: 'expense', category: '食費', amount: 1200, memo: '', ...extra });
async function start(t, options = {}) {
  const store = options.store === null ? null : await createStore();
  const { server } = createApp({ store, logger: { error() {} }, ...options }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); if (store) await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin: options.origin || base } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { store, server, base, call };
}

test('公開時に利用パスワードとHTTPSが必須。クラウド未設定は明示的セットアップモード', () => {
  assert.equal(readConfig({}).localOnly, true);
  assert.throws(() => readConfig({ HOST: '0.0.0.0' }));
  assert.throws(() => readConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'a-long-test-password', APP_ORIGIN: 'http://example.com' }));
  const c = readConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'a-long-test-password', RENDER_EXTERNAL_URL: 'https://example.com' });
  assert.equal(c.setupRequired, true); assert.equal(c.sqlitePath, '');
  assert.equal(readConfig({ ...c, DATABASE_URL: 'postgresql://user:pass@localhost/db' }).databaseUrl.startsWith('postgresql:'), true);
});
test('不正な設定を拒否し秘密をエラーに表示しない', () => {
  for (const PORT of ['0', '3.5', '999999']) assert.throws(() => readConfig({ PORT }), /PORT/);
  assert.throws(() => readConfig({ APP_PASSWORD: 'short' }), /12文字/);
  for (const APP_ORIGIN of ['bad', 'https://user:secret@example.com', 'https://example.com/path']) assert.throws(() => readConfig({ APP_ORIGIN }), /APP_ORIGIN/);
  assert.throws(() => readConfig({ DATABASE_URL: 'https://secret.example' }), /PostgreSQL/);
});
test('日付・金額・用途・割合の境界を検証する', () => {
  assert.equal(validDate('2026-02-29'), false); assert.equal(validDate('2024-02-29'), true); assert.equal(validDate('2026-13-01'), false);
  for (const amount of [-1, 0, 1.5, NaN, 1000000000, '1200']) assert.throws(() => validateEntry(sample({ amount })));
  assert.equal(validateEntry(sample({ amount: 999999999 })).amount, 999999999);
  assert.throws(() => validateEntry(sample({ purpose: 'invalid' })));
  assert.throws(() => validateEntry(sample({ businessRate: -1 })));
  assert.equal(validateEntry(sample({ businessRate: 0 })).businessRate, 0);
});
test('3件の記録と前月の記録を区別して集計し、カテゴリ金額を一致させる', () => {
  const rows = [sample({ type: 'income', category: '給与', amount: 300000 }), sample(), sample({ category: '交通費', amount: 800 }), sample({ date: '2026-09-30', amount: 10000 })];
  const s = summarize(rows, '2026-10'); assert.equal(s.income, 300000); assert.equal(s.expense, 2000); assert.equal(s.balance, 298000); assert.equal(s.count, 3); assert.deepEqual(s.categories, [{ name: '食費', amount: 1200 }, { name: '交通費', amount: 800 }]);
});
test('ログイン前の取得・登録・出力を拒否し、ログアウト後も保護する', async t => {
  const app = await start(t, { password: 'private-test-password' });
  for (const path of ['/api/entries', '/api/summary?month=2026-10', '/api/export?year=2026&format=csv']) assert.equal((await app.call(path)).status, 401);
  assert.equal((await app.call('/api/entries', 'POST', sample())).status, 401);
  assert.equal((await app.call('/api/login', 'POST', { password: 'wrong' })).status, 401);
  const login = await app.call('/api/login', 'POST', { password: 'private-test-password' }); assert.equal(login.status, 200);
  const set = login.headers.get('set-cookie'); assert.match(set, /HttpOnly; SameSite=Strict/);
  const headers = { cookie: set.split(';')[0] }; assert.equal((await app.call('/api/entries', 'GET', undefined, headers)).status, 200);
  const out = await app.call('/api/logout', 'POST', {}, headers); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.call('/api/entries', 'GET', undefined, headers)).status, 401);
});
test('セッション期限・ログイン回数制限・Secure Cookieを確認する', async t => {
  let time = 1000; const app = await start(t, { password: 'private-test-password', origin: 'https://money.example', localOnly: false, now: () => time });
  for (let i = 0; i < 10; i++) assert.equal((await app.call('/api/login', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await app.call('/api/login', 'POST', { password: 'private-test-password' })).status, 429);
  time += 60001; const res = await app.call('/api/login', 'POST', { password: 'private-test-password' }); const set = res.headers.get('set-cookie'); assert.match(set, /Secure/);
  time += 7 * 86400000 + 1; assert.equal((await app.call('/api/entries', 'GET', undefined, { cookie: set.split(';')[0] })).status, 401);
});
test('再起動相当の別サーバーでもログインを維持し、パスワード変更で無効化する', async t => {
  const app = await start(t, { password: 'private-test-password' });
  const login = await app.call('/api/login', 'POST', { password: 'private-test-password' }); const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const password of ['private-test-password', 'changed-test-password']) {
    const { server } = createApp({ store: app.store, password }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try { const result = await fetch(`http://127.0.0.1:${server.address().port}/api/entries`, { headers: { cookie } }); assert.equal(result.status, password === 'private-test-password' ? 200 : 401); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
});
test('CSRF・不正Host・不正JSON・サイズ制限を確認する', async t => {
  const app = await start(t);
  for (const path of ['/api/login', '/api/logout', '/api/entries', '/api/import/commit']) assert.equal((await app.call(path, 'POST', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(app.base + '/api/entries', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await app.call('/api/entries', 'POST', '{')).status, 400);
  assert.equal((await app.call('/api/entries', 'POST', 'x'.repeat(33000))).status, 413);
  assert.equal((await app.call('/api/entries', 'POST', {}, { 'content-type': 'text/plain' })).status, 415);
  const status = await new Promise((resolve, reject) => { const r = request(app.base, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end(); }); assert.equal(status, 403);
});
test('全レスポンスno-store、秘密や旧LINE生成APIを公開しない', async t => {
  const app = await start(t);
  for (const path of ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/sw.js', '/icon.svg']) {
    const res = await app.call(path); assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.match(res.headers.get('content-security-policy'), /object-src 'none'/);
  }
  for (const path of ['/.env', '/data/budget.sqlite', '/src/config.js']) assert.equal((await app.call(path)).status, 404);
  assert.equal((await app.call('/api/replies', 'POST', {})).status, 404);
});
test('記録を登録・編集・ゴミ箱移動・復元し集計を更新。競合上書きを拒否', async t => {
  const app = await start(t); const e = sample();
  const created = await (await app.call('/api/entries', 'POST', e)).json(); assert.equal(created.entry.version, 1);
  const updated = await (await app.call('/api/entries/' + e.id, 'PUT', { ...e, amount: 5000, version: 1 })).json(); assert.equal(updated.entry.amount, 5000);
  assert.equal((await app.call('/api/entries/' + e.id, 'PUT', { ...e, version: 1 })).status, 409);
  const deleted = await (await app.call('/api/entries/' + e.id, 'DELETE', { version: 2 })).json(); assert.equal(deleted.entry.deleted, true);
  assert.equal((await (await app.call('/api/entries')).json()).entries.length, 0);
  assert.equal((await (await app.call('/api/entries?trash=1')).json()).entries.length, 1);
  assert.equal((await app.call('/api/entries/' + e.id + '/restore', 'POST', { version: 3 })).status, 200);
  assert.equal((await (await app.call('/api/summary?month=2026-10')).json()).expense, 5000);
});
test('同一IDの再送は1件、異なる内容の同一IDは競合とする', async t => {
  const app = await start(t); const e = sample();
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.call('/api/entries', 'POST', e)));
  responses.forEach(r => assert.equal(r.status, 201));
  assert.equal((await app.store.list()).length, 1);
  assert.equal((await app.call('/api/entries', 'POST', { ...e, amount: 999 })).status, 409);
});
test('ローカルDBは接続を閉じても再読込できる', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'money-book-test-')); const path = join(dir, 'data.sqlite');
  t.after(async () => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/')); await rm(dir, { recursive: true, force: true }); });
  const a = await createStore({ sqlitePath: path }); await a.add(validateEntry(sample())); await a.close();
  const b = await createStore({ sqlitePath: path }); assert.equal((await b.list())[0].amount, 1200); await b.close();
});
test('クラウドDB未設定時に保存不能を明示し一時ディスクへ保存しない', async t => {
  const app = await start(t, { store: null }); const cfg = await (await app.call('/api/config')).json(); assert.equal(cfg.ready, false);
  assert.equal((await app.call('/api/entries', 'POST', sample())).status, 503);
});
test('メール抽出は候補だけ作り、日付不明はエラー付きにする', async t => {
  const app = await start(t);
  const res = await app.call('/api/import/preview', 'POST', { text: '2026年10月28日\n領収金額\n合計 １，２００円' });
  const { candidates } = await res.json(); assert.equal(candidates[0].amount, 1200); assert.equal(candidates[0].date, '2026-10-28'); assert.equal(candidates[0].purpose, '要確認');
  assert.equal((await app.store.list()).length, 0);
  const p = await parseImport({ text: '合計 500円' }); assert.match(p[0].error, /日付/);
  assert.throws(() => textCandidates('金額がありません'));
});
test('CSVの引用符・改行・日本語と数式インジェクションを扱う', async () => {
  assert.deepEqual(parseCSV('a,b\r\n"a,b","x""y"\r\n"line\nnext",0'), [['a', 'b'], ['a,b', 'x"y'], ['line\nnext', '0']]);
  const e = validateEntry(sample({ memo: '=HYPERLINK("test")' })); const csv = toCSV([e]); assert.match(csv, /'=HYPERLINK/);
  const rows = await parseImport({ name: 'book.csv', base64: Buffer.from(csv).toString('base64') }); assert.equal(rows.length, 1); assert.equal(rows[0].amount, 1200); assert.equal(rows[0].date, '2026-10-28');
});
test('Excel4シート・日付と数値型・事業割合0を保存し、二重取込しない', async () => {
  const e = validateEntry(sample({ purpose: '事業・副業', businessRate: 0 })); const bytes = await toXLSX([e], 2026);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bytes); assert.equal(wb.worksheets.length, 4); assert.equal(wb.getWorksheet('帳簿明細').getCell('E2').value, 1200); assert.ok(wb.getWorksheet('帳簿明細').getCell('B2').value instanceof Date);
  assert.equal(wb.getWorksheet('事業副業資料').getCell('G2').value, 0);
  const rows = await parseImport({ name: 'book.xlsx', base64: bytes.toString('base64') }); assert.equal(rows.length, 1); assert.equal(rows[0].businessRate, 0); assert.equal(rows[0].error, '');
});
test('旧Excelの18列見出しを認識し、メモ・事業割合・補填額を欠落させない', async () => {
  const csv = '管理ID,日付,年月,収支,家計カテゴリ,金額（円）,メモ・利用先,相手先・病院等,用途,税務科目,事業割合（%）,事業利用額（参考）,受診者,補てん額（円）,支払－補てん（参考）,証憑・原本,記録元,確認事項\nold-id-1234,2026/10/28,2026-10,支出,交通費,10000,テスト乗車,鉄道会社,事業・副業,旅費交通費,50,5000,,1200,,test.pdf,旧家計簿,確認済み';
  const [row] = await parseImport({ name: 'legacy.csv', base64: Buffer.from(csv).toString('base64') });
  assert.equal(row.category, '交通費'); assert.equal(row.amount, 10000); assert.equal(row.memo, 'テスト乗車'); assert.equal(row.businessRate, 50); assert.equal(row.compensation, 1200); assert.equal(row.partner, '鉄道会社'); assert.equal(row.error, '');
});
test('取込確認後だけ登録し同じ取込を再送しても増やさない', async t => {
  const app = await start(t); const preview = await (await app.call('/api/import/preview', 'POST', { text: '2026/10/28\n合計 1200円' })).json();
  const first = await (await app.call('/api/import/commit', 'POST', { entries: preview.candidates })).json(); assert.equal(first.added, 1);
  const next = await (await app.call('/api/import/commit', 'POST', { entries: preview.candidates })).json(); assert.equal(next.added, 0); assert.equal(next.skipped, 1);
  const repeated = await (await app.call('/api/import/preview', 'POST', { text: '2026/10/28\n合計 1200円' })).json(); assert.equal(repeated.candidates[0].duplicate, true);
});
test('不正な行を含む一括登録は保存前に止める', async t => {
  const app = await start(t); assert.equal((await app.call('/api/import/commit', 'POST', { entries: [sample(), sample({ date: '' })] })).status, 400); assert.equal((await app.store.list()).length, 0);
});
test('文字入りPDFの実データから日付と金額を抽出する', async () => {
  const content = 'BT /F1 12 Tf 50 750 Td (2026/10/28) Tj 0 -20 Td (Total \\245500) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const rows = await parseImport({ name: 'test-only.pdf', base64: Buffer.from(pdf).toString('base64') });
  assert.equal(rows[0].date, '2026-10-28'); assert.equal(rows[0].amount, 500);
});
test('年を絞ってCSV・Excel出力し、JSONは全期間を保存する', async t => {
  const app = await start(t); await app.store.add(validateEntry(sample())); await app.store.add(validateEntry(sample({ date: '2025-12-31' })));
  const csv = await app.call('/api/export?format=csv&year=2026'); assert.match(csv.headers.get('content-disposition'), /budget-2026.csv/); assert.equal(parseCSV(await csv.text()).length, 2);
  const xlsx = await app.call('/api/export?format=xlsx&year=2026'); assert.equal(xlsx.status, 200); assert.ok((await xlsx.arrayBuffer()).byteLength > 1000);
  const json = await (await app.call('/api/export?format=json&year=2026')).json(); assert.equal(json.entries.length, 2);
  assert.equal((await app.call('/api/export?format=csv&year=bad')).status, 400);
});
