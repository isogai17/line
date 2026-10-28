import { createHash, randomUUID } from 'node:crypto';
export const CATEGORIES = {
  expense: ['食費', '日用品', '家賃', '水道光熱費', '交通費', '通信費', '医療費', '交際費', '趣味・娯楽', '衣服・美容', 'その他'],
  income: ['給与', '副業', '事業売上', 'その他収入'],
};
export const PURPOSES = ['家計のみ', '事業・副業', '医療費資料', '要確認'];
export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2199-12-31') return false;
  const time = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(time.valueOf()) && time.toISOString().slice(0, 10) === value;
}
export function validateEntry(input, { id = input?.id || randomUUID() } = {}) {
  if (!input || typeof input !== 'object') fail('入力内容を確認してください。');
  if (typeof id !== 'string' || !/^[\w-]{8,100}$/.test(id)) fail('記録IDが正しくありません。');
  if (!['expense', 'income'].includes(input.type)) fail('支出か収入を選んでください。');
  if (!validDate(input.date)) fail('実在する日付を入力してください。');
  if (typeof input.category !== 'string' || !input.category.trim() || [...input.category].length > 30) fail('カテゴリは1〜30文字で入力してください。');
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 999999999) fail('金額は1〜999,999,999円の整数で入力してください。');
  const text = (key, length) => { const v = input[key] ?? ''; if (typeof v !== 'string' || [...v].length > length) fail(`${key}の文字数を確認してください。`); return v.trim(); };
  const purpose = input.purpose || '家計のみ';
  if (!PURPOSES.includes(purpose)) fail('用途を選んでください。');
  const businessRate = input.businessRate ?? 100;
  const compensation = input.compensation ?? 0;
  if (!Number.isFinite(businessRate) || businessRate < 0 || businessRate > 100) fail('事業割合は0〜100%で入力してください。');
  if (!Number.isSafeInteger(compensation) || compensation < 0 || compensation > 999999999) fail('補填額は0以上の整数で入力してください。');
  return { id, date: input.date, type: input.type, category: input.category.trim(), amount: input.amount,
    memo: text('memo', 500), purpose, taxCategory: text('taxCategory', 50), businessRate,
    partner: text('partner', 100), patient: text('patient', 30), compensation, sourceKey: text('sourceKey', 100) };
}
export const entryHash = e => createHash('sha256').update(JSON.stringify([e.date, e.type, e.category, e.amount, e.memo])).digest('hex');
export function summarize(entries, month) {
  const rows = entries.filter(e => !e.deleted && e.date.startsWith(month));
  const income = rows.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const expense = rows.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const byCategory = new Map();
  for (const e of rows.filter(e => e.type === 'expense')) byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);
  return { income, expense, balance: income - expense, count: rows.length,
    categories: [...byCategory].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount) };
}
