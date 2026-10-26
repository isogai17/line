import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createOpenAIGenerator, sampleGenerator } from '../src/replies.js';

const replies = { replies: [
  { label: '確認する', text: 'ありがとう！何時ごろを考えてる？' },
  { label: '確認してから', text: '誘ってくれてありがとう。予定を確認して返事するね。' },
  { label: '少し考える', text: '声をかけてくれてうれしい！少し考えさせてね。' },
] };

async function start(t, overrides = {}) {
  const calls = [];
  const { server } = createApp({ generator: async (input) => { calls.push(input); return replies; }, logger: { error() {} }, ...overrides });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, calls, post: (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: overrides.origin || base, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) };
}

test('LINEのキーなしで起動設定を読み、AIキーなしならサンプルにする', () => {
  const config = readConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.demo, true);
  assert.equal(readConfig({ OPENAI_API_KEY: 'test-key' }).demo, false);
  assert.equal(readConfig({ OPENAI_API_KEY: 'test-key' }, { sample: true }).demo, true);
});

test('外部公開ではパスワードとHTTPSの公開URLを必須にする', () => {
  assert.throws(() => readConfig({ HOST: '0.0.0.0' }), /外部に公開/);
  assert.throws(() => readConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'long-test-password', APP_ORIGIN: 'http://example.com' }), /外部に公開/);
  const config = readConfig({ HOST: '0.0.0.0', APP_PASSWORD: 'long-test-password', APP_ORIGIN: 'https://example.com/' });
  assert.equal(config.origin, 'https://example.com');
  assert.equal(config.localOnly, false);
});

test('Renderの自動公開URLで起動でき、明示したAPP_ORIGINを優先する', () => {
  const env = { HOST: '0.0.0.0', APP_PASSWORD: 'long-test-password', RENDER_EXTERNAL_URL: 'https://kotoba-test.onrender.com' };
  assert.equal(readConfig(env).origin, 'https://kotoba-test.onrender.com');
  assert.equal(readConfig({ ...env, APP_ORIGIN: 'https://reply.example.com' }).origin, 'https://reply.example.com');
  assert.throws(() => readConfig({ ...env, RENDER_EXTERNAL_URL: 'http://kotoba-test.onrender.com' }), /外部に公開/);
});

test('不正な設定は値をログに出さずに拒否する', () => {
  for (const PORT of ['abc', '1.1', '0', '65536']) assert.throws(() => readConfig({ PORT }), /PORT/);
  assert.throws(() => readConfig({ APP_PASSWORD: 'short' }), /12文字/);
  for (const APP_ORIGIN of ['invalid', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com?key=value', 'file:///']) {
    assert.throws(() => readConfig({ APP_ORIGIN }), /APP_ORIGIN/);
  }
});

test('AIモードでも画面・静的ファイルを公開し、設定には秘密を含めない', async (t) => {
  const app = await start(t, { password: 'private-test-password' });
  const config = await (await fetch(app.base + '/api/config')).json();
  assert.deepEqual(config, { mode: 'ai', authRequired: true, authenticated: false, maxInputLength: 3000 });
  for (const path of ['/', '/style.css', '/app.js']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.deepEqual(await (await fetch(app.base + '/healthz')).json(), { status: 'ok', mode: 'ai' });
});

test('Web画面からの依頼をAIへ送り、3案を返す（実HTTP・外部通信はテスト用）', async (t) => {
  const requests = [];
  const generator = createOpenAIGenerator({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(replies) }] }] });
  } });
  const app = await start(t, { generator });
  const response = await app.post('/api/replies', { message: ' 明日は参加できますか？ ', tone: 'polite' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...replies, sample: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.input[0].content[0].text, '明日は参加できますか？');
  assert.match(requests[0].body.instructions, /敬語/);
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-key');
});

test('5つの文体を個別に渡し、本文はコマンドとして扱わない', async (t) => {
  const app = await start(t);
  for (const tone of ['natural', 'polite', 'short', 'friendly', 'decline']) {
    assert.equal((await app.post('/api/replies', { message: 'ヘルプ', tone })).status, 200);
    assert.equal(app.calls.at(-1).tone, tone);
    assert.equal(app.calls.at(-1).message, 'ヘルプ');
  }
});

test('空文・長文・不正な文体を拒否し、AIを呼ばない', async (t) => {
  const app = await start(t);
  for (const input of [null, {}, { message: 123 }, { message: '   ' }, { message: 'あ'.repeat(3001) },
    { message: 'test', tone: 'toString' }, { message: 'test', tone: {} }]) {
    assert.equal((await app.post('/api/replies', input)).status, 400);
  }
  assert.equal(app.calls.length, 0);
  assert.equal((await app.post('/api/replies', { message: '😀'.repeat(3000) })).status, 200);
});

test('不正JSON・大きすぎる本文・JSON以外を拒否する', async (t) => {
  const app = await start(t);
  assert.equal((await app.post('/api/replies', '{')).status, 400);
  assert.equal((await app.post('/api/replies', 'x'.repeat(32769))).status, 413);
  assert.equal((await app.post('/api/replies', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(app.calls.length, 0);
});

test('別サイトとOriginなしの生成・ログイン・ログアウトを拒否する', async (t) => {
  const app = await start(t);
  for (const path of ['/api/replies', '/api/login', '/api/logout']) {
    assert.equal((await app.post(path, { message: 'hi' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(app.base + path, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await app.post(path, {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  }
  assert.equal(app.calls.length, 0);
});

test('ローカル利用時は未知のHostを拒否する', async (t) => {
  const app = await start(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(app.base + '/api/config', { headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('ログイン・認証Cookie・ログアウトを通して生成権限を管理する', async (t) => {
  const app = await start(t, { password: 'private-test-password' });
  assert.equal((await app.post('/api/replies', { message: 'hi' })).status, 401);
  assert.equal((await app.post('/api/login', { password: 'wrong' })).status, 401);
  const login = await app.post('/api/login', { password: 'private-test-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /private-test-password/);
  const headers = { cookie: cookie.split(';')[0] };
  assert.equal((await (await fetch(app.base + '/api/config', { headers })).json()).authenticated, true);
  assert.equal((await app.post('/api/replies', { message: 'hi' }, headers)).status, 200);
  const loggedOut = await app.post('/api/logout', {}, headers);
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.post('/api/replies', { message: 'hi' }, headers)).status, 401);
});

test('セッションの期限後は再ログインが必要', async (t) => {
  let time = 1000;
  const app = await start(t, { password: 'private-test-password', now: () => time });
  const login = await app.post('/api/login', { password: 'private-test-password' });
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  time += 12 * 60 * 60 * 1000 + 1;
  assert.equal((await app.post('/api/replies', { message: 'hi' }, headers)).status, 401);
});

test('HTTPS公開時はSecure Cookieと指定オリジンを使う', async (t) => {
  const app = await start(t, { password: 'private-test-password', origin: 'https://reply.example.com', localOnly: false });
  const login = await app.post('/api/login', { password: 'private-test-password' });
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert.equal((await app.post('/api/login', {}, { origin: app.base })).status, 403);
});

test('ログイン試行回数を制限し、時間が経過すると再試行できる', async (t) => {
  let time = 1000;
  const app = await start(t, { password: 'private-test-password', now: () => time });
  for (let i = 0; i < 10; i++) assert.equal((await app.post('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await app.post('/api/login', { password: 'private-test-password' })).status, 429);
  time += 60_001;
  assert.equal((await app.post('/api/login', { password: 'private-test-password' })).status, 200);
});

test('生成回数を制限し、不正入力は回数に含めない', async (t) => {
  let time = 1000;
  const app = await start(t, { generationLimit: 1, now: () => time });
  assert.equal((await app.post('/api/replies', {})).status, 400);
  assert.equal((await app.post('/api/replies', { message: 'hi' })).status, 200);
  const busy = await app.post('/api/replies', { message: 'hi' });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '60');
  time += 60_001;
  assert.equal((await app.post('/api/replies', { message: 'hi' })).status, 200);
});

test('同時実行の上限を超えた生成は外部APIを呼ぶ前に断る', async (t) => {
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const running = new Promise((resolve) => { started = resolve; });
  const app = await start(t, { maxConcurrent: 1, generator: async () => { started(); await blocked; return replies; } });
  const first = app.post('/api/replies', { message: 'hi' });
  await running;
  try { assert.equal((await app.post('/api/replies', { message: 'second' })).status, 503); }
  finally { release(); }
  assert.equal((await first).status, 200);
});

test('生成失敗・タイムアウト・壊れた出力を適切に案内し、秘密を隠す', async (t) => {
  const logs = [];
  let error = new Error('private-message api-key');
  const app = await start(t, { generator: async () => { throw error; }, logger: { error: (...args) => logs.push(args) } });
  const failed = await app.post('/api/replies', { message: 'private-message' });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /private-message|api-key/);
  error = new DOMException('timeout-secret', 'TimeoutError');
  assert.equal((await app.post('/api/replies', { message: 'hi' })).status, 504);
  error = new SyntaxError('secret-response');
  assert.equal((await app.post('/api/replies', { message: 'hi' })).status, 502);
  assert.doesNotMatch(JSON.stringify(logs), /private|secret|api-key/);
});

test('3案以外や不正な本文は成功扱いにしない', async (t) => {
  const app = await start(t, { generator: async () => ({ replies: [null, null, null] }) });
  assert.equal((await app.post('/api/replies', { message: 'hi' })).status, 502);
});

test('サンプルは文体別の3案を返し、実AIと区別できる', async (t) => {
  const app = await start(t, { demo: true, generator: sampleGenerator });
  const response = await app.post('/api/replies', { message: '明日来られる？', tone: 'decline' });
  const data = await response.json();
  assert.equal(data.sample, true);
  assert.equal(data.replies.length, 3);
  assert.match(data.replies[0].text, /遠慮/);
  assert.equal((await (await fetch(app.base + '/api/config')).json()).mode, 'sample');
  assert.equal((await app.post('/webhook', {})).status, 404);
  assert.equal((await app.post('/api/sample', {})).status, 404);
});

test('外部AIの認証・利用上限・不完全な応答を成功扱いにしない', async () => {
  for (const status of [401, 429, 500]) {
    const generator = createOpenAIGenerator({ apiKey: 'test', fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(generator({ message: 'こんにちは' }), new RegExp(`AI_HTTP_${status}`));
  }
  for (const data of [
    { status: 'incomplete', output: [] }, { status: 'completed', output: [] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"replies":[]}' }] }] },
  ]) {
    const generator = createOpenAIGenerator({ apiKey: 'test', fetchImpl: async () => Response.json(data) });
    await assert.rejects(generator({ message: 'こんにちは' }));
  }
});

test('利用者の中止シグナルを外部AIリクエストに伝える', async () => {
  let requestSignal;
  const generator = createOpenAIGenerator({ apiKey: 'test', fetchImpl: async (_url, options) => {
    requestSignal = options.signal;
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(replies) }] }] });
  } });
  const controller = new AbortController();
  await generator({ message: 'hi', signal: controller.signal });
  assert.equal(requestSignal.aborted, false);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
});
