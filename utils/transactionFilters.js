// Reads and checks the filter values from the transactions page address (?from=...&category=...)
// and builds the matching SQL. User input is only ever passed as parameters, never joined into the SQL.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

function isRealDate(s) {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// query: the parsed address values, categoryIds: the ids of the logged-in user's categories
function parseFilters(query, categoryIds) {
  // Only plain text values count (a repeated ?from=a&from=b is an array and is ignored)
  const get = (key) => (typeof query[key] === 'string' ? query[key].trim() : '');
  const values = {
    from: get('from'), to: get('to'), category: get('category'), type: get('type'),
    min: get('min'), max: get('max'), q: get('q'),
  };
  const errors = {};
  const filters = {};

  if (values.from) {
    if (isRealDate(values.from)) filters.from = values.from;
    else errors.from = 'Enter a valid date.';
  }
  if (values.to) {
    if (isRealDate(values.to)) filters.to = values.to;
    else errors.to = 'Enter a valid date.';
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.to = 'The To date must not be before the From date.';
    delete filters.from;
    delete filters.to;
  }

  if (values.category) {
    if (/^\d+$/.test(values.category) && categoryIds.includes(Number(values.category))) {
      filters.category = Number(values.category);
    } else {
      errors.category = 'Choose one of your categories.';
    }
  }

  if (values.type) {
    if (values.type === 'income' || values.type === 'expense') filters.type = values.type;
    else errors.type = 'Choose income or expense.';
  }

  const amountMessage = 'Enter an amount like 100 or 99.50.';
  for (const key of ['min', 'max']) {
    if (!values[key]) continue;
    const normal = values[key].replace(',', '.'); // accept 99,50 as well as 99.50
    if (AMOUNT.test(normal)) filters[key] = Number(normal);
    else errors[key] = amountMessage;
  }
  if (filters.min !== undefined && filters.max !== undefined && filters.min > filters.max) {
    errors.max = 'The maximum must not be less than the minimum.';
    delete filters.min;
    delete filters.max;
  }

  if (values.q) {
    if (values.q.length <= 100) filters.q = values.q;
    else errors.q = 'Search text must be 100 characters or fewer.';
  }

  const page = /^\d+$/.test(get('page')) && Number(get('page')) >= 1 ? Number(get('page')) : 1;
  return { filters, values, errors, page };
}

// Makes % and _ in the search text mean themselves, not "match anything"
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

function buildWhere(filters, userId) {
  const clauses = ['t.user_id = ?']; // every query is limited to the logged-in user
  const params = [userId];
  if (filters.from) { clauses.push('t.date >= ?'); params.push(filters.from); }
  if (filters.to) { clauses.push('t.date <= ?'); params.push(filters.to); }
  if (filters.category) { clauses.push('t.category_id = ?'); params.push(filters.category); }
  if (filters.type) { clauses.push('t.type = ?'); params.push(filters.type); }
  if (filters.min !== undefined) { clauses.push('t.amount >= ?'); params.push(filters.min); }
  if (filters.max !== undefined) { clauses.push('t.amount <= ?'); params.push(filters.max); }
  if (filters.q) { clauses.push("t.note LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(filters.q)}%`); }
  return { where: clauses.join(' AND '), params };
}

module.exports = { parseFilters, buildWhere };