const db = require('../db');
const { budgetStatus, budgetPercent } = require('./budgetStatus');
const { monthLabel } = require('./months');

const round2 = (n) => Math.round(n * 100) / 100;

// Spent so far this month on one category (expenses only)
const SPENT_SQL = `COALESCE((SELECT SUM(t.amount) FROM transactions t
                              WHERE t.category_id = c.id AND t.user_id = c.user_id
                                AND t.type = 'expense' AND substr(t.date, 1, 7) = ?), 0)`;

// Every category with its budget for the month (if any) and what was spent on it that month
function loadMonth(userId, month) {
  const rows = db
    .prepare(
      `SELECT c.id AS category_id, c.name, b.id AS budget_id, b.amount_limit, ${SPENT_SQL} AS spent
         FROM categories c
         LEFT JOIN budgets b ON b.category_id = c.id AND b.user_id = c.user_id AND b.month = ?
        WHERE c.user_id = ?
        ORDER BY c.name`
    )
    .all(month, month, userId);

  const budgeted = rows
    .filter((r) => r.budget_id !== null)
    .map((r) => {
      const spent = round2(r.spent);
      return {
        ...r,
        spent,
        remaining: round2(r.amount_limit - spent),
        status: budgetStatus(spent, r.amount_limit),
        percent: budgetPercent(spent, r.amount_limit),
        barWidth: Math.min(100, budgetPercent(spent, r.amount_limit)),
      };
    });
  const unbudgeted = rows.filter((r) => r.budget_id === null);

  const limit = round2(budgeted.reduce((sum, b) => sum + b.amount_limit, 0));
  const spent = round2(budgeted.reduce((sum, b) => sum + b.spent, 0));
  return { budgeted, unbudgeted, categories: rows, totals: { limit, spent, remaining: round2(limit - spent) } };
}

// A flash message for right after an expense is saved, or null when nothing needs a warning
function budgetNotice(userId, categoryId, month) {
  const row = db
    .prepare(
      `SELECT c.name, b.amount_limit, ${SPENT_SQL} AS spent
         FROM budgets b JOIN categories c ON c.id = b.category_id
        WHERE b.user_id = ? AND b.category_id = ? AND b.month = ?`
    )
    .get(month, userId, categoryId, month);
  if (!row) return null;

  const status = budgetStatus(row.spent, row.amount_limit);
  const percent = budgetPercent(row.spent, row.amount_limit);
  const label = monthLabel(month);
  if (status === 'exceeded') {
    return { type: 'danger', message: `${row.name} is over its ${label} budget (${percent}% used).` };
  }
  if (status === 'warning') {
    return { type: 'warning', message: `Heads up: ${row.name} has used ${percent}% of its ${label} budget.` };
  }
  return null;
}

module.exports = { loadMonth, budgetNotice };