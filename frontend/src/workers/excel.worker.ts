import * as XLSX from 'xlsx';
import { MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS } from '../utils/tabularImport';
self.onmessage = e => {
  try {
    const book = XLSX.read(e.data, { type: 'array', sheets: 0, sheetRows: MAX_IMPORT_ROWS + 2, cellHTML: false, cellFormula: false });
    const sheetName = book.SheetNames[0];
    if (!sheetName) throw new Error('В Excel-файле нет листов.');
    const sheet = book.Sheets[sheetName], ref = sheet['!fullref'] ?? sheet['!ref'];
    if (!ref) throw new Error('Excel-лист пустой.');
    const range = XLSX.utils.decode_range(ref);
    if (range.e.r - range.s.r + 1 > MAX_IMPORT_ROWS + 1 || range.e.c - range.s.c + 1 > MAX_IMPORT_COLUMNS) throw new Error('Превышен предел строк или колонок Excel.');
    const rows = (XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '', raw: true }) as unknown[][]).map(row => row.map(v => String(v ?? '')));
    if (!rows.length || rows.every(row => row.length < 2)) throw new Error('В Excel должно быть минимум две колонки.');
    self.postMessage({ result: { rows, sheetName } });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
