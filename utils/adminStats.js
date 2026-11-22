// Usage statistics for the admin page. Everything here is a count or a total across all users:
// no query returns an individual transaction, an amount, a note, or which user did what.
const db = require('../db');
const { lastMonths, shortMonth } = require('./months');

// A category name is only shown to the admin when this many different users use it,
// because custom names can be personal ("Divorce lawyer") and should not identify one person.
const MIN_USERS_FOR_CATEGORY = 2;

function adminStats(month) {
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;

  const totalUsers = count("SELECT COUNT(*) AS n FROM users WHERE role = 'user'");
  const newUsers = count("SELECT COUNT(*) AS n FROM users WHERE role = 'user' AND substr(created_at, 1, 7) = ?", month);
  const activeUsers = count('SELECT COUNT(DISTINCT user_id) AS n FROM transactions WHERE substr(date, 1, 7) = ?', month);
  const totalTransactions = count('SELECT COUNT(*) AS n FROM transactions');

  // Transactions per month for the last 6 months (all users combined), zeros for empty months
  const months = lastMonths(month, 6);
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS month, COUNT(*) AS n
         FROM transactions
        WHERE substr(date, 1, 7) BETWEEN ? AND ?
        GROUP BY substr(date, 1, 7)`
    )
    .all(months[0], months[months.length - 1]);
  const byMonth = Object.fromEntries(rows.map((r) => [r.month, r.n]));
  const perMonth = months.map((m) => ({ month: m, label: shortMonth(m), count: byMonth[m] || 0 }));

  // Most used category names, grouping Groceries and groceries together
  const topCategories = db
    .prepare(
      `SELECT MIN(c.name) AS name, COUNT(t.id) AS uses, COUNT(DISTINCT c.user_id) AS users
         FROM categories c
         JOIN transactions t ON t.category_id = c.id
        GROUP BY lower(c.name)
       HAVING COUNT(DISTINCT c.user_id) >= ?
        ORDER BY uses DESC, name
        LIMIT 5`
    )
    .all(MIN_USERS_FOR_CATEGORY);

  return { totalUsers, newUsers, activeUsers, totalTransactions, perMonth, topCategories };
}

module.exports = { adminStats, MIN_USERS_FOR_CATEGORY };