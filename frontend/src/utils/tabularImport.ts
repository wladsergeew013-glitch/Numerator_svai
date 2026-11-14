export const MAX_IMPORT_BYTES = 16_000_000;
export const MAX_IMPORT_ROWS = 100000;
export const MAX_IMPORT_COLUMNS = 256;

export function parseCsvRecords(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  text = text.replace(/^\uFEFF/, '');
  if (!delimiter) {
    const counts = new Map([[';', 0], [',', 0], ['\t', 0]]); let quoted = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
      else if (!quoted && (text[i] === '\r' || text[i] === '\n')) break;
      else if (!quoted && counts.has(text[i])) counts.set(text[i], counts.get(text[i])! + 1);
    }
    delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  const endCell = () => { row.push(cell); cell = ''; if (row.length > MAX_IMPORT_COLUMNS) throw new Error('Слишком много колонок.'); };
  const endRow = () => { endCell(); if (row.some(c => c.trim())) rows.push(row); row = []; if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error('Превышен предел 100000 строк.'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || cell === '') quoted = !quoted;
      else throw new Error('CSV: кавычки внутри неэкранированного поля.');
    } else if (!quoted && c === delimiter) endCell();
    else if (!quoted && (c === '\r' || c === '\n')) { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cell += c;
    if (cell.length > 262144) throw new Error('CSV: слишком длинное поле.');
  }
  if (quoted) throw new Error('CSV: незакрытые кавычки.');
  if (cell || row.length) endRow();
  if (!rows.length || rows[0].length < 2) throw new Error('Нужны минимум две колонки X и Y.');
  return { rows, delimiter };
}

export function guessTableHeader(rows: string[][]): boolean {
  const first = rows[0] ?? [];
  const norm = (s: string) => s.trim().toLowerCase().replace(/[ _-]/g, '');
  const knownX = first.some(s => /^(x|х|coordx|coordinatex|xcoord)$/.test(norm(s)));
  const knownY = first.some(s => /^(y|у|coordy|coordinatey|ycoord)$/.test(norm(s)));
  return knownX && knownY;
}

export function tableWithHeader(allRows: string[][], hasHeader: boolean) {
  if (!allRows.length || allRows.length > MAX_IMPORT_ROWS + 1) throw new Error('Недопустимое число строк.');
  const width = allRows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width < 2 || width > MAX_IMPORT_COLUMNS) throw new Error('Недопустимое число колонок.');
  const columns = Array.from({ length: width }, (_, i) => hasHeader ? allRows[0][i]?.trim() || `Колонка ${i + 1}` : `Колонка ${i + 1}`);
  const rows = hasHeader ? allRows.slice(1) : allRows;
  if (rows.length > MAX_IMPORT_ROWS) throw new Error('Превышен предел 100000 строк.');
  return { hasHeader, columns, rows, previewRows: rows.slice(0, 12), allRows };
}
