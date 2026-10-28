'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const yen = v => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(v);
const today = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return ['year', 'month', 'day'].map(t => p.find(x => x.type === t).value).join('-'); };
const colors = ['#236653', '#88a975', '#d4b06d', '#7eabb0', '#c9896e', '#9c94b6', '#8d9e87', '#d1bd9f', '#7295a6', '#a48083', '#aaa986'];
let state = { config: null, entries: [], trash: [], candidates: [], view: 'overview', month: today().slice(0, 7), allMonths: false };
let editing = null, draftID = crypto.randomUUID(), savePending = false, toastTimer, deletedEntry = null, loaded = false;

function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
function connection(text, error = false) { $('#connection').textContent = text; $('#connection').classList.toggle('connection-error', error); }
async function api(path, { method = 'GET', body } = {}) {
  let response;
  try { response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }); }
  catch { connection('未接続・保存は未完了', true); throw new Error('通信できません。入力を残したまま、接続を確認して再試行してください。'); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') { state.entries = []; state.trash = []; loaded = false; showLogin(); }
    throw new Error(data.error || '操作を完了できませんでした。');
  }
  return data;
}
function showLogin() { $('#shell').hidden = true; $('#login-screen').hidden = false; $('#password').focus(); }
function showView(view, focus = true) {
  if (!['overview', 'entry', 'history', 'tools'].includes(view)) view = 'overview';
  state.view = view;
  $$('.view').forEach(el => { el.hidden = el.id !== `${view}-view`; });
  $$('[data-view]').forEach(el => { const active = el.dataset.view === view; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('#page-label').textContent = { overview: 'ホーム', entry: 'かんたん入力', history: '記録を見る', tools: '取込・出力' }[view];
  if (view === 'history') renderHistory();
  if (focus) { window.scrollTo({ top: 0, behavior: 'instant' }); if (view === 'entry') $('#amount').focus({ preventScroll: true }); else $('#main').focus({ preventScroll: true }); }
}
async function load() {
  if (!state.config?.ready) return;
  connection('読み込み中');
  const { entries } = await api('/api/entries');
  state.entries = entries; loaded = true;
  if ($('#trash-toggle').checked) state.trash = (await api('/api/entries?trash=1')).entries;
  connection(state.config.storage === 'cloud' ? 'クラウド保存・同期済み' : 'このPCに保存');
  render();
}
function sumRows(rows) {
  let income = 0, expense = 0; const categories = new Map();
  for (const e of rows) { if (e.type === 'income') income += e.amount; else { expense += e.amount; categories.set(e.category, (categories.get(e.category) || 0) + e.amount); } }
  return { income, expense, balance: income - expense, categories: [...categories].sort((a, b) => b[1] - a[1]) };
}
function render() {
  const rows = state.entries.filter(e => e.date.startsWith(state.month));
  const s = sumRows(rows);
  for (const key of ['income', 'expense', 'balance']) $('#' + key).textContent = loaded ? yen(s[key]) : '—';
  $('#month-count').textContent = loaded ? `${rows.length}件の記録` : '未読み込み';
  $('#recent').innerHTML = rows.length ? rows.slice(0, 5).map(e => recordHTML(e, false)).join('') : '<div class="empty-list"><strong>最初のひとつを、記録してみましょう。</strong>金額とカテゴリを選ぶだけで始められます。<br><button class="text-button add-entry">＋ 記録をつける</button></div>';
  $('#chart-empty').hidden = s.expense > 0; $('#chart-content').hidden = !s.expense;
  $('#chart-total').textContent = yen(s.expense);
  let offset = 0; const circumference = 2 * Math.PI * 80;
  $('#donut').innerHTML = '<title id="chart-title">カテゴリ別支出の円グラフ。内訳は隣の一覧に表示しています。</title>' + s.categories.map(([name, amount], i) => { const part = amount / s.expense * circumference; const circle = `<circle cx="110" cy="110" r="80" fill="none" stroke="${colors[i % colors.length]}" stroke-width="27" stroke-dasharray="${part} ${circumference - part}" stroke-dashoffset="${-offset}"><title>${esc(name)} ${yen(amount)}</title></circle>`; offset += part; return circle; }).join('');
  $('#legend').innerHTML = s.categories.map(([name, amount], i) => `<li><svg aria-hidden="true" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${colors[i % colors.length]}"/></svg><span class="legend-name">${esc(name)}</span><strong>${yen(amount)}</strong></li>`).join('');
  renderHistory();
}
const categoryIcon = category => ({ 食費: '食', 家賃: '住', 交通費: '移', 医療費: '医', 日用品: '日', 給与: '収', 副業: '副', 通信費: '通', 水道光熱費: '光', 交際費: '交' })[category] || '¥';
function recordHTML(e, actions, trash = false) {
  return `<div class="record"><div class="record-icon" aria-hidden="true">${categoryIcon(e.category)}</div><button class="record-main" data-edit="${esc(e.id)}" ${trash ? 'disabled' : ''} aria-label="${esc(e.date + ' ' + e.category + ' ' + e.amount + '円を編集')}"><strong>${esc(e.memo || e.category)}</strong><small>${esc(e.date.replaceAll('-', '/'))} · ${esc(e.category)}${e.purpose !== '家計のみ' ? ' · ' + esc(e.purpose) : ''}</small></button><span class="record-amount ${e.type}">${e.type === 'income' ? '+' : '−'}${yen(e.amount)}</span>${actions ? `<div class="record-actions">${trash ? `<button class="text-button" data-restore="${esc(e.id)}">戻す</button>` : `<button class="text-button" data-copy="${esc(e.id)}" aria-label="${esc(e.category)}をもう一度入力">再入力</button><button class="text-button" data-delete="${esc(e.id)}" aria-label="${esc(e.category)}をゴミ箱へ">削除</button>`}</div>` : ''}</div>`;
}
function renderHistory() {
  const trash = $('#trash-toggle').checked, query = $('#search').value.trim().toLocaleLowerCase(), type = $('#history-type').value;
  const rows = (trash ? state.trash : state.entries).filter(e => (state.allMonths || e.date.startsWith(state.month)) && (type === 'all' || e.type === type) && [e.category, e.memo, e.partner, e.purpose].join(' ').toLocaleLowerCase().includes(query));
  $('#history-list').innerHTML = rows.length ? rows.map(e => recordHTML(e, true, trash)).join('') : '<div class="empty-list"><strong>該当する記録はありません。</strong>対象月や検索条件を変えてみてください。</div>';
  $('#history-count').textContent = `${rows.length}件${trash ? '（削除済み。集計には含まれません）' : ''}`;
  $('#history-month').textContent = state.allMonths ? '全期間' : state.month;
  $('#history-all').textContent = state.allMonths ? '選択月だけ表示' : '全期間を表示';
}
function selectedType() { return $('#entry-form input[name=type]:checked').value; }
function renderCategories(preferred = '') {
  const type = selectedType(); const categories = [...new Set([...state.config.categories[type], ...state.entries.filter(e => e.type === type).map(e => e.category)])];
  const chosen = preferred || categories[0];
  $('#category').value = chosen;
  $('#categories').innerHTML = categories.map(c => `<option value="${esc(c)}"></option>`).join('');
  $('#category-chips').innerHTML = categories.slice(0, 11).map(c => `<button type="button" data-category="${esc(c)}" class="${chosen === c ? 'active' : ''}" aria-pressed="${chosen === c}">${esc(c)}</button>`).join('');
}
function resetEntry() {
  editing = null; draftID = crypto.randomUUID(); $('#entry-form').reset(); $('#date').value = today(); $('#entry-error').textContent = '';
  $('#entry-heading').textContent = 'さっと、ひとつ記録。'; $('#save-entry').textContent = '記録を保存する'; $('#cancel-edit').hidden = true; $('#tax-details').open = false;
  if (state.config) renderCategories();
}
function editEntry(e, copy = false) {
  resetEntry(); editing = copy ? null : e;
  $(`#entry-form input[name=type][value="${e.type}"]`).checked = true; renderCategories(e.category);
  $('#amount').value = e.amount; $('#date').value = copy ? today() : e.date; $('#memo').value = e.memo;
  $('#purpose').value = e.purpose; $('#tax-category').value = e.taxCategory; $('#business-rate').value = e.businessRate;
  $('#partner').value = e.partner; $('#patient').value = e.patient; $('#compensation').value = e.compensation;
  $('#tax-details').open = e.purpose !== '家計のみ';
  $('#entry-heading').textContent = copy ? '同じ内容で、もうひとつ。' : '記録を修正する';
  $('#save-entry').textContent = copy ? '新しい記録として保存' : '変更を保存する'; $('#cancel-edit').hidden = copy;
  showView('entry');
}
function formEntry() {
  const amount = Number($('#amount').value.normalize('NFKC').replaceAll(',', ''));
  return { id: editing?.id || draftID, type: selectedType(), amount, date: $('#date').value, category: $('#category').value.trim(), memo: $('#memo').value.trim(), purpose: $('#purpose').value,
    taxCategory: $('#tax-category').value.trim(), businessRate: Number($('#business-rate').value), partner: $('#partner').value.trim(), patient: $('#patient').value.trim(), compensation: Number($('#compensation').value), sourceKey: editing?.sourceKey || '', ...(editing ? { version: editing.version } : {}) };
}
async function saveEntry(event) {
  event.preventDefault(); if (savePending || !state.config.ready) return;
  savePending = true; $('#save-entry').disabled = true; $('#entry-error').textContent = '';
  try {
    const entry = formEntry(); const data = await api(editing ? `/api/entries/${editing.id}` : '/api/entries', { method: editing ? 'PUT' : 'POST', body: entry });
    const index = state.entries.findIndex(e => e.id === data.entry.id); if (index < 0) state.entries.push(data.entry); else state.entries[index] = data.entry;
    state.entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); loaded = true;
    const edited = !!editing; state.month = entry.date.slice(0, 7); $('#month').value = state.month;
    resetEntry(); render(); connection(state.config.storage === 'cloud' ? 'クラウドに保存しました' : 'このPCに保存しました'); toast(edited ? '変更を保存しました。' : `${yen(entry.amount)}を保存しました。続けて入力できます。`); $('#amount').focus({ preventScroll: true });
  } catch (error) { $('#entry-error').textContent = error.message; }
  finally { savePending = false; $('#save-entry').disabled = !state.config?.ready; }
}
function renderCandidates(candidates) {
  state.candidates = candidates; $('#import-preview').hidden = false;
  const dup = candidates.filter(c => c.duplicate).length;
  $('#preview-summary').textContent = `${candidates.length}件を読み取りました。重複候補${dup}件。チェックを入れた明細だけ登録します。`;
  $('#candidate-rows').innerHTML = candidates.map((c, i) => `<tr class="${c.duplicate ? 'row-duplicate' : c.error ? 'row-error' : ''}" data-candidate="${i}"><td><input type="checkbox" data-field="selected" aria-label="${i + 1}行目を登録" ${!c.error && !c.duplicate ? 'checked' : ''}></td><td><input type="date" data-field="date" value="${esc(c.date)}" min="1900-01-01" max="2199-12-31" aria-label="${i + 1}行目の日付"></td><td><select data-field="type" aria-label="${i + 1}行目の収支"><option value="">選択</option><option value="expense" ${c.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${c.type === 'income' ? 'selected' : ''}>収入</option></select></td><td><input data-field="category" maxlength="30" value="${esc(c.category)}" aria-label="${i + 1}行目のカテゴリ"></td><td><input type="number" data-field="amount" min="1" max="999999999" step="1" value="${esc(c.amount)}" aria-label="${i + 1}行目の金額"></td><td><input data-field="memo" maxlength="500" value="${esc(c.memo)}" aria-label="${i + 1}行目のメモ"></td><td>${esc(c.duplicate ? '重複候補：原則除外' : c.error || c.warning || '原本と確認してください')}</td></tr>`).join('');
  $('#import-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function preview(kind) {
  const button = $(kind === 'file' ? '#preview-file' : '#preview-text'); button.disabled = true; $('#tools-error').textContent = '';
  try {
    let body;
    if (kind === 'text') body = { text: $('#mail-text').value };
    else {
      const file = $('#import-file').files[0]; if (!file) throw new Error('ファイルを選んでください。'); if (file.size > 10 * 1024 * 1024) throw new Error('ファイルは10MB以内にしてください。');
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('ファイルを読めませんでした。')); reader.readAsDataURL(file); });
      body = { name: file.name, base64 };
    }
    const { candidates } = await api('/api/import/preview', { method: 'POST', body }); renderCandidates(candidates);
  } catch (error) { $('#tools-error').textContent = error.message; }
  finally { button.disabled = !state.config.ready; }
}
async function commitImport() {
  $('#commit-import').disabled = true; $('#tools-error').textContent = '';
  try {
    const entries = $$('[data-candidate]').filter(row => row.querySelector('[data-field=selected]').checked).map(row => {
      const entry = { ...state.candidates[Number(row.dataset.candidate)] };
      row.querySelectorAll('[data-field]').forEach(el => { if (el.dataset.field !== 'selected') entry[el.dataset.field] = el.dataset.field === 'amount' ? Number(el.value) : el.value; }); return entry;
    });
    if (!entries.length) throw new Error('登録する明細にチェックを入れてください。');
    const result = await api('/api/import/commit', { method: 'POST', body: { entries } });
    $('#import-preview').hidden = true; $('#candidate-rows').replaceChildren(); state.candidates = []; $('#mail-text').value = ''; $('#import-file').value = '';
    await load(); toast(`${result.added}件を保存しました。重複${result.skipped}件は除外しました。`);
  } catch (error) { $('#tools-error').textContent = error.message; }
  finally { $('#commit-import').disabled = false; }
}
async function download(format, button) {
  button.disabled = true; $('#tools-error').textContent = '';
  try {
    const year = Number($('#export-year').value); if (!Number.isInteger(year) || year < 1900 || year > 2199) throw new Error('対象年を正しく入力してください。');
    const res = await fetch(`/api/export?format=${format}&year=${year}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60000) });
    if (!res.ok) { const body = await res.json(); throw new Error(body.error || '出力できませんでした。'); }
    const blob = await res.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `家計簿_${format === 'json' ? '全期間バックアップ' : year}.${format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('ファイルのダウンロードを開始しました。');
  } catch (error) { $('#tools-error').textContent = error.message || '出力できませんでした。'; }
  finally { button.disabled = !state.config.ready; }
}
async function removeEntry(e) {
  deletedEntry = e; $('#delete-description').textContent = `${e.date} / ${e.category} / ${yen(e.amount)}`; $('#delete-dialog').showModal();
}
async function restoreEntry(e) {
  const { entry } = await api(`/api/entries/${e.id}/restore`, { method: 'POST', body: { version: e.version } });
  state.trash = state.trash.filter(x => x.id !== entry.id); await load(); toast('記録を元に戻しました。');
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.view) { showView(button.dataset.view); return; }
    if (button.classList.contains('add-entry')) { resetEntry(); showView('entry'); return; }
    if (button.dataset.category) { $('#category').value = button.dataset.category; $$('#category-chips button').forEach(b => { const active = b === button; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); return; }
    if (button.dataset.edit) { const e = state.entries.find(e => e.id === button.dataset.edit); if (e) editEntry(e); return; }
    if (button.dataset.copy) { const e = state.entries.find(e => e.id === button.dataset.copy); if (e) editEntry(e, true); return; }
    if (button.dataset.delete) { const e = state.entries.find(e => e.id === button.dataset.delete); if (e) await removeEntry(e); return; }
    if (button.dataset.restore) { button.disabled = true; const e = state.trash.find(e => e.id === button.dataset.restore); if (e) await restoreEntry(e); return; }
    if (button.dataset.export) await download(button.dataset.export, button);
  } catch (error) { toast(error.message); } finally { if (button.dataset.restore) button.disabled = false; }
});
$('#entry-form').addEventListener('submit', saveEntry);
$$('#entry-form input[name=type]').forEach(el => el.addEventListener('change', () => renderCategories()));
$('#category').addEventListener('input', () => { $$('#category-chips button').forEach(b => { const active = b.dataset.category === $('#category').value; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); });
$('#cancel-edit').addEventListener('click', () => { resetEntry(); showView('history'); });
$('#show-history').addEventListener('click', () => showView('history'));
function setMonth(value) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2199-12') return; state.month = value; $('#month').value = value; state.allMonths = false; render(); }
$('#month').value = state.month; $('#month').addEventListener('change', e => setMonth(e.target.value));
$('#prev-month').addEventListener('click', () => shiftMonth(-1)); $('#next-month').addEventListener('click', () => shiftMonth(1));
function shiftMonth(by) { const d = new Date(state.month + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + by); setMonth(d.toISOString().slice(0, 7)); }
$('#this-month').addEventListener('click', () => setMonth(today().slice(0, 7)));
$('#search').addEventListener('input', renderHistory); $('#history-type').addEventListener('change', renderHistory);
$('#history-all').addEventListener('click', () => { state.allMonths = !state.allMonths; renderHistory(); });
$('#trash-toggle').addEventListener('change', async () => { try { if ($('#trash-toggle').checked) state.trash = (await api('/api/entries?trash=1')).entries; renderHistory(); } catch (error) { toast(error.message); } });
$('#refresh').addEventListener('click', async () => { try { await load(); toast('最新の記録を読み込みました。'); } catch (error) { toast(error.message); } });
$('#preview-file').addEventListener('click', () => preview('file')); $('#preview-text').addEventListener('click', () => preview('text'));
$('#commit-import').addEventListener('click', commitImport);
$('#close-preview').addEventListener('click', () => { $('#import-preview').hidden = true; state.candidates = []; $('#candidate-rows').replaceChildren(); });
$('#delete-dialog').addEventListener('close', async () => {
  const e = deletedEntry; deletedEntry = null; if ($('#delete-dialog').returnValue !== 'delete' || !e) return;
  try { await api(`/api/entries/${e.id}`, { method: 'DELETE', body: { version: e.version } }); await load(); toast('ゴミ箱へ移しました。記録画面の「ゴミ箱」から戻せます。'); } catch (error) { toast(error.message); }
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#login-form button'); button.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; await boot(); }
  catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; }
});
async function logout() {
  try { await api('/api/logout', { method: 'POST', body: {} }); state.entries = []; state.trash = []; state.candidates = []; loaded = false; resetEntry(); render(); $('#candidate-rows').replaceChildren(); $('#mail-text').value = ''; $('#import-file').value = ''; showLogin(); toast('ログアウトしました。'); } catch (error) { toast(error.message); }
}
$('#logout').addEventListener('click', logout); $('#logout-mobile').addEventListener('click', logout);
$('.brand').addEventListener('click', event => { event.preventDefault(); showView('overview'); });
async function boot() {
  $('#boot-error').hidden = true;
  state.config = await api('/api/config');
  if (!state.config.authenticated) { showLogin(); return; }
  $('#login-screen').hidden = true; $('#shell').hidden = false; $('#logout').hidden = !state.config.authRequired;
  $('#logout-mobile').hidden = !state.config.authRequired;
  $('#privacy-label').textContent = state.config.authRequired ? 'パスワードで保護' : 'ローカル確認用・認証なし';
  $('#setup-banner').hidden = state.config.ready; $('#local-banner').hidden = state.config.storage !== 'local';
  $('#save-entry').disabled = !state.config.ready;
  for (const button of [$('#preview-file'), $('#preview-text'), ...$$('[data-export]')]) button.disabled = !state.config.ready;
  $('#save-help').textContent = state.config.storage === 'cloud' ? 'クラウドへの保存完了後、ほかの端末でも確認できます。' : 'このPCのデータベースへ保存します。';
  $('#export-year').value = today().slice(0, 4); resetEntry(); showView(state.view, false);
  if (state.config.ready) await load(); else { connection('保存先の設定待ち', true); render(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('#shell').hidden && state.config?.ready && !savePending) load().catch(() => connection('未接続・再読み込みが必要', true)); });
window.addEventListener('online', () => { if (!$('#shell').hidden) load().catch(() => connection('再接続できません', true)); });
window.addEventListener('offline', () => connection('オフライン・保存できません', true));
window.addEventListener('beforeunload', event => { if (!$('#shell').hidden && $('#amount').value) { event.preventDefault(); event.returnValue = ''; } });
boot().catch(error => { $('#boot-error').textContent = error.message + ' ページを再読み込みしてください。'; $('#boot-error').hidden = false; });
