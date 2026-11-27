// Reads a bank statement saved as CSV and turns each row into a transaction, row by row.
// Rows that cannot be used are reported with their line number instead of stopping the whole import.
const { parse } = require('csv-parse/sync');

const MAX_ROWS = 500;
const MAX_NOTE = 200;

// Header names we understand (the header row is not case sensitive)
const ALIASES = {
  date: ['date', 'transaction date'],
  amount: ['amount', 'value'],
  note: ['note', 'description', 'details', 'reference'],
  category: ['category'],
  type: ['type'],
};

const pad = (n) => String(n).padStart(2, '0');
const show = (value) => String(value).slice(0, 30); // keeps error messages short

// Accepts 2026-11-05, 2026/11/05 and 05/11/2026 (day first). Returns YYYY-MM-DD or null.
function parseDate(text) {
  let y, m, d, match;
  if ((match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text))) [, y, m, d] = match;
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) [, d, m, y] = match;
  else return null;
  [y, m, d] = [Number(y), Number(m), Number(d)];
  const date = new Date(Date.UTC(y, m - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return real && y >= 2000 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

// Accepts -125.50, 125.5, +50 and 99,50. Thousands separators are not accepted. Returns a number or null.
function parseAmount(text) {
  let s = text.replace(/\s/g, '');
  if (/^[+-]?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // 99,50 means 99.50
  if (!/^[+-]?\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

// categories: the user's categories [{ id, name }], defaultCategoryId: used when a row names no known category
function parseStatement(text, categories, defaultCategoryId) {
  let records;
  try {
    records = parse(text, {
      columns: (header) => header.map((h) => String(h).trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    return { fatal: 'The file could not be read. Check that it is a CSV file with a header row and the same number of columns on every row.' };
  }
  if (records.length === 0) return { fatal: 'The file has no transactions in it.' };
  if (records.length > MAX_ROWS) return { fatal: `The file has more than ${MAX_ROWS} rows. Split it into smaller files.` };

  const headers = Object.keys(records[0]);
  const column = (name) => ALIASES[name].find((alias) => headers.includes(alias));
  const dateCol = column('date');
  const amountCol = column('amount');
  const noteCol = column('note');
  const categoryCol = column('category');
  const typeCol = column('type');
  if (!dateCol || !amountCol) {
    return { fatal: 'The first row must be a header with at least a "date" column and an "amount" column.' };
  }

  const categoryIds = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const rows = [];
  const problems = [];

  records.forEach((rec, i) => {
    const line = i + 2; // line 1 is the header
    const problem = (message) => problems.push({ line, message });

    const date = parseDate(String(rec[dateCol] || ''));
    if (!date) return problem(`Invalid date "${show(rec[dateCol] || '')}". Use YYYY-MM-DD or DD/MM/YYYY.`);

    const signed = parseAmount(String(rec[amountCol] || ''));
    if (signed === null) {
      return problem(`Invalid amount "${show(rec[amountCol] || '')}". Use numbers like -125.50, with a dot for cents and no thousands separators.`);
    }
    if (signed === 0) return problem('The amount cannot be 0.');

    // A negative amount is an expense and a positive one is income, unless there is a type column
    let type = signed < 0 ? 'expense' : 'income';
    if (typeCol && rec[typeCol]) {
      const given = rec[typeCol].toLowerCase();
      if (given !== 'income' && given !== 'expense') return problem(`Invalid type "${show(rec[typeCol])}". Use income or expense.`);
      type = given;
    }

    let categoryId = defaultCategoryId;
    let usedDefault = true;
    if (categoryCol && rec[categoryCol]) {
      const found = categoryIds.get(rec[categoryCol].toLowerCase());
      if (found) {
        categoryId = found;
        usedDefault = false;
      }
    }

    const note = (noteCol ? String(rec[noteCol] || '') : '').slice(0, MAX_NOTE);
    rows.push({
      line,
      date,
      type,
      amount: Math.round(Math.abs(signed) * 100) / 100,
      note: note || null,
      category_id: categoryId,
      usedDefault,
    });
  });

  return { rows, problems, total: records.length };
}

module.exports = { parseStatement, parseDate, parseAmount, MAX_ROWS, MAX_NOTE };