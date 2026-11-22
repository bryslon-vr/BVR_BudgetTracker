const db = require('../db');
const { lastMonths, shortMonth } = require('./months');
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

// Income and expenses for each of the last `count` months ending at endMonth, oldest first.
// Months with no transactions are included with 0, so the chart always has the same number of bars.
function incomeVsExpenses(userId, endMonth, count = 6) {
  const months = lastMonths(endMonth, count);
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
         FROM transactions
        WHERE user_id = ? AND substr(date, 1, 7) BETWEEN ? AND ?
        GROUP BY substr(date, 1, 7)`
    )
    .all(userId, months[0], months[months.length - 1]);
  const byMonth = Object.fromEntries(rows.map((r) => [r.month, r]));

  return months.map((m) => ({
    month: m,
    label: shortMonth(m),
    income: round2(byMonth[m] ? byMonth[m].income : 0),
    expense: round2(byMonth[m] ? byMonth[m].expense : 0),
  }));
}

module.exports = { monthTotals, groupTop, spendingByCategory, incomeVsExpenses };