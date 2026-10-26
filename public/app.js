const form = document.querySelector('#reply-form');
const message = document.querySelector('#message');
const generate = document.querySelector('#generate');
const results = document.querySelector('.results');
const drafts = document.querySelector('#drafts');
const status = document.querySelector('#status');
const empty = document.querySelector('#empty-state');
const resultCount = document.querySelector('#result-count');
const workspace = document.querySelector('#app-workspace');
const loginSection = document.querySelector('#login-section');
const logout = document.querySelector('#logout');
let sample = false;
let ready = false;
let busy = false;
let controller;

function applyMode(isSample) {
  sample = isSample;
  document.querySelector('#mode-badge').textContent = sample ? '操作サンプル' : 'AI返信アシスタント';
  document.querySelector('#mode-title').textContent = sample ? 'いまは操作を試すサンプルです' : 'LINEの登録・連携なしで使えます';
  document.querySelector('#mode-description').textContent = sample
    ? '固定の例文を表示します。入力に合わせたAI生成には、管理者によるAI接続の設定が必要です。'
    : '文章を貼り付けて、返信案を作成。確認・編集したら、元のチャットにコピーして送ってください。';
  updateControls();
}

function updateControls() {
  const length = [...message.value].length;
  document.querySelector('#character-count').textContent = `${length.toLocaleString('ja-JP')} / 3,000`;
  generate.disabled = !ready || busy || !message.value.trim() || length > 3000;
  generate.textContent = busy ? '返信案を準備しています…' : sample ? '返信案のサンプルを見る ↗' : '返信案を作る ↗';
  message.readOnly = busy;
  for (const radio of form.querySelectorAll('input[type="radio"]')) radio.disabled = busy;
  document.querySelector('#use-example').disabled = busy;
  document.querySelector('#clear').disabled = busy;
  document.querySelector('#cancel').hidden = !busy;
  results.setAttribute('aria-busy', String(busy));
}

function resetOutput() {
  drafts.replaceChildren();
  resultCount.hidden = true;
  empty.hidden = false;
  status.textContent = '';
}

async function loadConfig() {
  ready = false;
  updateControls();
  const response = await fetch('/api/config', { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('接続できませんでした。ページを再読み込みしてください。');
  const config = await response.json();
  applyMode(config.mode === 'sample');
  ready = config.authenticated;
  workspace.hidden = !ready;
  loginSection.hidden = ready;
  logout.hidden = !ready || !config.authRequired;
  updateControls();
}

async function post(path, body, signal) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '処理に失敗しました。もう一度お試しください。');
    error.status = response.status;
    throw error;
  }
  return data;
}

message.addEventListener('input', () => { resetOutput(); updateControls(); });
form.addEventListener('change', (event) => { if (event.target.name === 'tone') resetOutput(); });
document.querySelector('#use-example').addEventListener('click', () => {
  message.value = '久しぶり！今週の土曜日、ごはん行かない？';
  resetOutput();
  updateControls();
  message.focus();
});
document.querySelector('#clear').addEventListener('click', () => {
  form.reset();
  resetOutput();
  updateControls();
  message.focus();
});
document.querySelector('#cancel').addEventListener('click', () => controller?.abort());

function renderReplies(replies) {
  drafts.replaceChildren();
  for (const [index, reply] of replies.entries()) {
    const card = document.createElement('article');
    card.className = 'draft';
    const header = document.createElement('div');
    header.className = 'draft-header';
    const title = document.createElement('h3');
    title.textContent = `${String(index + 1).padStart(2, '0')}  ${reply.label}`;
    const editor = document.createElement('textarea');
    editor.className = 'draft-editor';
    editor.rows = 3;
    editor.maxLength = 2000;
    editor.value = reply.text;
    editor.setAttribute('aria-label', `返信案${index + 1}を編集`);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-button';
    copy.textContent = 'コピー';
    copy.setAttribute('aria-label', `返信案${index + 1}をコピー`);
    editor.addEventListener('input', () => { copy.textContent = 'コピー'; });
    copy.addEventListener('click', async () => {
      if (!editor.value.trim()) { status.textContent = 'コピーする文章を入力してください。'; editor.focus(); return; }
      try {
        await navigator.clipboard.writeText(editor.value);
        copy.textContent = 'コピー済み';
        status.textContent = 'コピーしました。LINEなど元のチャットに貼り付けて送信してください。';
      } catch {
        editor.focus();
        editor.select();
        status.textContent = 'コピーできませんでした。選択された文章を手動でコピーしてください。';
      }
    });
    header.append(title, copy);
    card.append(header, editor);
    drafts.append(card);
  }
  empty.hidden = true;
  resultCount.hidden = false;
  resultCount.textContent = sample ? '3つの例文' : '3つの返信案';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ready || busy || !message.value.trim() || !form.reportValidity()) return;
  const input = { message: message.value.trim(), tone: new FormData(form).get('tone') || 'natural' };
  busy = true;
  controller = new AbortController();
  resetOutput();
  updateControls();
  try {
    const data = await post('/api/replies', input, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
    applyMode(data.sample);
    renderReplies(data.replies);
    status.textContent = data.sample ? '固定の例文です。入力に合わせたAI生成ではありません。' : '返信案はその場で編集できます。内容を確認してからコピーしてください。';
  } catch (error) {
    status.textContent = error.name === 'AbortError' ? '作成を中止しました。'
      : error.name === 'TimeoutError' ? '時間がかかっています。もう一度お試しください。'
      : error instanceof TypeError ? '接続できませんでした。通信状況を確認して、もう一度お試しください。' : error.message;
    if (error.status === 401) {
      ready = false;
      workspace.hidden = true;
      loginSection.hidden = false;
      logout.hidden = true;
      document.querySelector('#login-status').textContent = 'セッションの期限が切れました。もう一度ログインしてください。';
    }
  } finally {
    busy = false;
    controller = undefined;
    updateControls();
  }
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#login-button');
  const password = document.querySelector('#password');
  const loginStatus = document.querySelector('#login-status');
  if (button.disabled) return;
  button.disabled = true;
  loginStatus.textContent = '';
  try {
    await post('/api/login', { password: password.value }, AbortSignal.timeout(10_000));
    password.value = '';
    await loadConfig();
    message.focus();
  } catch (error) {
    loginStatus.textContent = error instanceof TypeError ? '接続できませんでした。もう一度お試しください。' : error.message;
  } finally { button.disabled = false; }
});

logout.addEventListener('click', async () => {
  controller?.abort();
  logout.disabled = true;
  try {
    await post('/api/logout', {}, AbortSignal.timeout(10_000));
    form.reset();
    resetOutput();
    await loadConfig();
    document.querySelector('#password').focus();
  } catch {
    status.textContent = 'ログアウトできませんでした。もう一度お試しください。';
  } finally { logout.disabled = false; }
});

loadConfig().catch(() => {
  document.querySelector('#mode-title').textContent = 'アプリに接続できませんでした';
  document.querySelector('#mode-description').textContent = '通信状況を確認して、ページを再読み込みしてください。';
});
