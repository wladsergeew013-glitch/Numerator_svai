import { MAX_PROJECT_POINTS } from './projectLimits';

export const MAX_IMPORT_BYTES = 16_000_000;
export const MAX_IMPORT_ROWS = MAX_PROJECT_POINTS;
export const MAX_IMPORT_COLUMNS = 256;
export const CSV_DELIMITERS = [';', ',', '\t'] as const;

function readCsvRecords(text: string, delimiter: string, sampleSize = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoteState: 'unquoted' | 'quoted' | 'closed' = 'unquoted';
  const endCell = () => {
    row.push(cell);
    cell = '';
    quoteState = 'unquoted';
    if (row.length > MAX_IMPORT_COLUMNS) throw new Error('Слишком много колонок.');
  };
  const endRow = () => {
    endCell();
    if (row.some(c => c.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error('Превышен предел 100000 строк.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoteState === 'quoted') {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoteState = 'closed';
    } else if (c === delimiter) {
      endCell();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= sampleSize) return rows;
    } else if (quoteState === 'closed') {
      throw new Error('CSV: после закрывающей кавычки ожидается разделитель или конец строки.');
    } else if (c === '"') {
      if (cell) throw new Error('CSV: кавычки внутри неэкранированного поля.');
      quoteState = 'quoted';
    } else cell += c;
    if (cell.length > 262144) throw new Error('CSV: слишком длинное поле.');
  }
  if (quoteState === 'quoted') throw new Error('CSV: незакрытые кавычки.');
  if (cell || row.length || quoteState === 'closed') endRow();
  return rows;
}

export function parseImportNumber(value = '') {
  const text = value.trim().replace(/[ \u00a0\u202f]/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function csvDelimiterScore(rows: string[][]): number {
  if (!rows.length || rows[0].length < 2) return -1;
  const hasHeader = guessTableHeader(rows);
  const numeric = rows.slice(hasHeader ? 1 : 0).filter(row =>
    Number.isFinite(parseImportNumber(row[0])) && Number.isFinite(parseImportNumber(row[1]))).length;
  const consistent = rows.filter(row => row.length === rows[0].length).length;
  return (hasHeader ? 1000 : 0) + numeric * 20 + consistent;
}

export function parseCsvRecords(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  text = text.replace(/^\uFEFF/, '');
  if (!delimiter) {
    let best = -1;
    for (const candidate of CSV_DELIMITERS) {
      try {
        const score = csvDelimiterScore(readCsvRecords(text, candidate, 12));
        if (score > best) { best = score; delimiter = candidate; }
      } catch { /* This delimiter does not parse the sample. */ }
    }
  }
  if (!delimiter || !CSV_DELIMITERS.some(candidate => candidate === delimiter)) {
    throw new Error('CSV: не удалось определить разделитель для колонок X и Y.');
  }
  const rows = readCsvRecords(text, delimiter);
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

function escapeCsv(value: string) {
  if (/[",\n\r;]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function makeNormalizedCsvFile(
  preview: { fileName: string; rows: string[][]; columns: string[]; hasHeader: boolean },
  xIndex: number,
  yIndex: number,
  numberIndex: number | null,
  basePoint: { enabled: boolean; x: number; y: number }
): File {
  const errorFor = (row: number, axis: 'X' | 'Y', column: number) =>
    new Error(`Строка ${row}, координата ${axis} (${preview.columns[column] ?? axis}): ожидается конечное десятичное число.`);
  const format = (value: number) => {
    const scaled = value * 1000;
    return String(basePoint.enabled && Number.isFinite(scaled) ? Math.round(scaled) / 1000 : value);
  };
  const lines = ['X,Y,Number'];
  for (const [index, row] of preview.rows.entries()) {
    if (!row.some(value => value.trim())) continue;
    const rowNumber = index + (preview.hasHeader ? 2 : 1);
    const parsedX = parseImportNumber(row[xIndex]);
    const parsedY = parseImportNumber(row[yIndex]);
    if (!Number.isFinite(parsedX)) throw errorFor(rowNumber, 'X', xIndex);
    if (!Number.isFinite(parsedY)) throw errorFor(rowNumber, 'Y', yIndex);
    const x = basePoint.enabled ? parsedX - basePoint.x : parsedX;
    const y = basePoint.enabled ? parsedY - basePoint.y : parsedY;
    if (!Number.isFinite(x)) throw errorFor(rowNumber, 'X', xIndex);
    if (!Number.isFinite(y)) throw errorFor(rowNumber, 'Y', yIndex);
    const number = numberIndex === null ? '' : row[numberIndex] ?? '';
    lines.push([format(x), format(y), escapeCsv(number)].join(','));
  }
  const name = preview.fileName.replace(/\.(csv|xlsx|xls)$/i, '') || 'import';
  return new File([lines.join('\n')], `${name}.normalized.csv`, { type: 'text/csv;charset=utf-8' });
}
