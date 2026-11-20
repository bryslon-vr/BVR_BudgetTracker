const db = require('../db');

const round2 = (n) => Math.round(n * 100) / 100;

// Income, expenses and balance for one month (all categories, whether or not they have a budget)
function monthTotals(userId, month) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
         FROM transactions
        WHERE user_id = ? AND substr(date, 1, 7) = ?`
    )
    .get(userId, month);
  const income = round2(row.income);
  const expense = round2(row.expense);
  return { income, expense, balance: round2(income - expense) };
}

// Keeps the biggest slices and merges the rest into "Other", so the chart stays readable.
// rows must already be sorted from biggest to smallest.
function groupTop(rows, max = 6) {
  if (rows.length <= max) return rows;
  const top = rows.slice(0, max - 1);
  const other = round2(rows.slice(max - 1).reduce((sum, r) => sum + r.total, 0));
  return [...top, { name: 'Other', total: other }];
}

// What was spent per category in a month, biggest first, with each slice's share of the total
function spendingByCategory(userId, month, max = 6) {
  const rows = db
    .prepare(
      `SELECT c.name AS name, SUM(t.amount) AS total
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = ? AND t.type = 'expense' AND substr(t.date, 1, 7) = ?
        GROUP BY c.id
        ORDER BY total DESC, c.name`
    )
    .all(userId, month)
    .map((r) => ({ name: r.name, total: round2(r.total) }));

  const total = round2(rows.reduce((sum, r) => sum + r.total, 0));
  const slices = groupTop(rows, max).map((s) => ({ ...s, percent: total > 0 ? Math.round((s.total * 100) / total) : 0 }));
  return { slices, total };
}

module.exports = { monthTotals, groupTop, spendingByCategory };