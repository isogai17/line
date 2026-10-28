import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, validateEntry, validDate, fail, summarize } from './domain.js';

export const HEADERS = ['ID', '日付', '収支', 'カテゴリ', '金額', 'メモ', '用途', '税務科目', '事業割合', '相手先・病院', '受診者', '補填額', '取込元ID'];
const values = e => [e.id, e.date, e.type === 'income' ? '収入' : '支出', e.category, e.amount, e.memo, e.purpose, e.taxCategory, e.businessRate, e.partner, e.patient, e.compensation, e.sourceKey];
const safeCSV = v => '"' + String(typeof v === 'string' && /^[\s]*[=+@-]/.test(v) ? "'" + v : v ?? '').replace(/"/g, '""') + '"';
export const toCSV = rows => '\uFEFF' + [HEADERS, ...rows.map(values)].map(r => r.map(safeCSV).join(',')).join('\r\n') + '\r\n';
export async function toXLSX(entries, year) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'わたしの家計簿';
  const data = wb.addWorksheet('帳簿明細');
  data.addRow(HEADERS);
  entries.forEach(e => { const v = values(e); v[1] = new Date(e.date + 'T00:00:00Z'); data.addRow(v); });
  data.columns.forEach((c, i) => { c.width = [38, 15, 10, 18, 17, 36, 18, 20, 14, 25, 18, 17, 40][i]; });
  data.getColumn(2).numFmt = 'yyyy/mm/dd';
  for (const c of [5, 12]) data.getColumn(c).numFmt = '#,##0';
  const monthly = wb.addWorksheet('月別集計');
  monthly.addRow(['月', '収入', '支出', '収支']);
  for (let m = 1; m <= 12; m++) { const month = `${year}-${String(m).padStart(2, '0')}`; const s = summarize(entries, month); monthly.addRow([month, s.income, s.expense, s.balance]); }
  monthly.columns.forEach(c => { c.width = 20; });
  const business = wb.addWorksheet('事業副業資料');
  business.addRow(['日付', '収支', '税務科目', '相手先', '金額', '事業割合(%)', '事業分の参考額', 'メモ']);
  entries.filter(e => e.purpose === '事業・副業').forEach(e => business.addRow([new Date(e.date + 'T00:00:00Z'), e.type === 'income' ? '収入' : '支出', e.taxCategory, e.partner, e.amount, e.businessRate, Math.round(e.amount * e.businessRate / 100), e.memo]));
  business.columns.forEach(c => { c.width = 22; }); business.getColumn(1).numFmt = 'yyyy/mm/dd';
  const medical = wb.addWorksheet('医療費資料');
  medical.addRow(['支払日', '受診者', '病院・薬局等', '支払額', '補填額', '支払－補填(参考)', 'メモ']);
  entries.filter(e => e.purpose === '医療費資料').forEach(e => medical.addRow([new Date(e.date + 'T00:00:00Z'), e.patient, e.partner, e.amount, e.compensation, Math.max(0, e.amount - e.compensation), e.memo]));
  medical.columns.forEach(c => { c.width = 23; }); medical.getColumn(1).numFmt = 'yyyy/mm/dd';
  for (const sheet of wb.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
    sheet.getRow(1).height = 30;
    sheet.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF236653' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
    sheet.eachRow((row, index) => { if (index > 1) row.height = 24; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], value = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; } else if (ch === '"') quote = false; else value += ch; }
    else if (ch === '"' && value === '') quote = true;
    else if (ch === ',') { row.push(value); value = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(value); if (row.some(x => x !== '')) rows.push(row); row = []; value = ''; }
    else value += ch;
  }
  if (quote) fail('CSVの引用符が閉じられていません。');
  row.push(value); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
function cellValue(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === 'object') return v.result ?? v.text ?? (v.richText?.map(x => x.text).join('') || '');
  return v ?? '';
}
function normalizeDate(v) {
  const s = String(cellValue(v)).trim().replace(/年|月|\//g, '-').replace(/日/g, '');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : s;
}
function mapRows(rows) {
  const normalizeHeader = value => String(cellValue(value)).normalize('NFKC').trim();
  const headerIndex = rows.findIndex(r => { const h = r.map(normalizeHeader); return h.includes('日付') && (h.includes('金額') || h.includes('金額(円)')); });
  if (headerIndex < 0) fail('「日付・収支・カテゴリ・金額」の見出しがあるCSV/Excelを選んでください。旧Excelは「帳簿明細」を出力して取り込めます。');
  const headers = rows[headerIndex].map(normalizeHeader);
  const legacy = headers[3] === '収支' && /^金額/.test(headers[5]);
  const result = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r.some(v => v !== '' && v !== null)) continue;
    const get = (...names) => { const normalized = names.map(normalizeHeader); const index = headers.findIndex(h => normalized.includes(h)); return index < 0 ? '' : cellValue(r[index]); };
    const direction = get('収支', '種別', 'type');
    result.push({ date: normalizeDate(get('日付')), type: ['収入', 'income'].includes(direction) ? 'income' : ['支出', 'expense'].includes(direction) ? 'expense' : '',
      category: String(get('カテゴリ', '家計簿カテゴリ', '家計カテゴリ') || (legacy ? r[4] : '')), amount: Number(String(get('金額', '金額（円）')).replace(/[,￥¥円\s]/g, '')),
      memo: String(get('メモ', '内容', 'メモ・利用先') || ''), purpose: String(get('用途') || '要確認'),
      taxCategory: String(get('税務科目', '申告用科目', '科目') || ''), businessRate: get('事業割合', '事業割合（%）', '事業割合(%)') === '' ? 100 : Number(get('事業割合', '事業割合（%）', '事業割合(%)')),
      partner: String(get('相手先・病院', '相手先/病院', '相手先・病院等') || ''), patient: String(get('受診者', '受診者名') || ''), compensation: Number(get('補填額', '補てん金額', '補てん額', '補てん額（円）') || 0),
      sourceKey: String(get('取込元ID', 'ID', '管理ID', '明細ID', '記録ID') || ''), rowNumber: i + 1 });
  }
  return result;
}
export function textCandidates(text) {
  if (typeof text !== 'string' || text.length > 100000) fail('本文は10万文字以内で入力してください。');
  const normalized = text.normalize('NFKC');
  const date = normalized.match(/(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/);
  const day = date ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` : '';
  const lines = normalized.split(/\r?\n/);
  const totals = lines.filter(s => /合計|総額|請求金額|お支払(?:い)?金額|ご利用金額/.test(s));
  const candidates = [];
  for (const line of (totals.length ? totals : lines)) {
    const amounts = [...line.matchAll(/(?:[¥￥]\s*([\d,]+)|([\d,]+)\s*円)/g)];
    for (const match of amounts) {
      const amount = Number((match[1] || match[2]).replaceAll(',', ''));
      if (amount > 0) candidates.push({ date: day, type: 'expense', category: 'その他', amount, memo: line.trim().slice(0, 300), purpose: '要確認' });
    }
  }
  if (!candidates.length) fail('金額を読み取れませんでした。「合計 1,200円」のような本文を確認してください。画像だけのPDFは文字認識が別途必要です。');
  return candidates;
}
export async function parseImport({ name, base64, text }) {
  let rows;
  if (text !== undefined) rows = textCandidates(text);
  else {
    if (typeof name !== 'string' || typeof base64 !== 'string' || base64.length > 14000000) fail('ファイルは10MB以内で選んでください。');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 10 * 1024 * 1024) fail('ファイルは10MB以内にしてください。');
    if (/\.csv$/i.test(name)) {
      let decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      if (decoded.includes('\uFFFD')) decoded = new TextDecoder('shift_jis').decode(buffer);
      rows = mapRows(parseCSV(decoded));
    } else if (/\.xlsx$/i.test(name)) {
      // ZIP爆弾を展開前に中央ディレクトリの非圧縮サイズで制限。
      let expanded = 0, files = 0;
      for (let i = 0; i < buffer.length - 46; i++) if (buffer.readUInt32LE(i) === 0x02014b50) {
        expanded += buffer.readUInt32LE(i + 24); files++; i += 45;
      }
      if (expanded > 40 * 1024 * 1024 || files > 1500 || !files) fail('このExcelは大きすぎるか、形式が対応していません。CSVで保存し直してください。');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const sheet = wb.getWorksheet('帳簿明細') || wb.getWorksheet('申告用明細') || wb.worksheets[0];
      const matrix = []; sheet.eachRow({ includeEmpty: true }, r => { matrix.push(r.values.slice(1).map(cellValue)); });
      rows = mapRows(matrix);
    } else if (/\.pdf$/i.test(name)) {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true,
        standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/'),
        cMapUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url)).replaceAll('\\', '/'), cMapPacked: true });
      const doc = await task.promise;
      try {
        if (doc.numPages > 30) fail('PDFは30ページ以内にしてください。');
        let body = '';
        for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); const content = await page.getTextContent(); body += content.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n'; if (body.length > 100000) fail('PDFの文字数が多すぎます。'); }
        rows = textCandidates(body);
      } finally { await task.destroy(); }
    } else if (/\.json$/i.test(name)) {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!Array.isArray(parsed.entries)) fail('家計簿のバックアップJSONを選んでください。');
      rows = parsed.entries.map(e => ({ ...e, sourceKey: e.sourceKey || e.id || '' }));
    } else fail('CSV、xlsx、文字入りPDF、家計簿JSONを選んでください。');
  }
  if (!rows.length) fail('取り込める明細がありません。');
  if (rows.length > 500) fail('一度に取り込めるのは500件です。ファイルを分けてください。');
  return rows.map((e, index) => {
    const candidate = { ...e, id: undefined, sourceKey: /^source-[a-f0-9]{64}$/.test(e.sourceKey || '') ? e.sourceKey : e.sourceKey ? 'source-' + createHash('sha256').update(e.sourceKey).digest('hex') : '' };
    let error = '';
    try { validateEntry(candidate); } catch (ex) { error = ex.message; }
    return { ...candidate, rowNumber: e.rowNumber || index + 1, error,
      warning: text !== undefined || /\.pdf$/i.test(name || '') ? '自動抽出です。日付・金額・収支を原本と確認してください。' : '' };
  });
}
