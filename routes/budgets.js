const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { isMonth, currentMonth, shiftMonth, monthLabel } = require('../utils/months');

const router = express.Router();
router.use(requireRole('user')); // only normal users have budgets

const round2 = (n) => Math.round(n * 100) / 100;

// Validation for setting a budget
const budgetRules = [
  body('month').custom((value) => {
    if (!isMonth(value)) throw new Error('Choose a valid month.');
    return true;
  }),
  body('category_id').custom((value, { req }) => {
    const id = Number(value);
    const row = Number.isInteger(id)
      ? db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(id, req.session.user.id)
      : null;
    if (!row) throw new Error('Please choose one of your categories.');
    return true;
  }),
  body('amount_limit')
    .trim()
    .customSanitizer((v) => String(v).replace(',', '.')) // accept 1500,50 as well as 1500.50
    .notEmpty().withMessage('Please enter a monthly limit.').bail()
    .matches(/^\d{1,9}(\.\d{1,2})?$/).withMessage('Enter an amount like 1500 or 1500.50.').bail()
    .custom((v) => Number(v) > 0).withMessage('The limit must be greater than 0.'),
];

// Every category with its budget for the month (if any) and what was spent on it that month
function loadMonth(userId, month) {
  const rows = db
    .prepare(
      `SELECT c.id AS category_id, c.name, b.id AS budget_id, b.amount_limit,
              COALESCE((SELECT SUM(t.amount) FROM transactions t
                         WHERE t.category_id = c.id AND t.user_id = c.user_id
                           AND t.type = 'expense' AND substr(t.date, 1, 7) = ?), 0) AS spent
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
      const ratio = spent / r.amount_limit;
      return {
        ...r,
        spent,
        remaining: round2(r.amount_limit - spent),
        percent: Math.floor(ratio * 100),
        barWidth: Math.min(100, ratio * 100),
      };
    });
  const unbudgeted = rows.filter((r) => r.budget_id === null);

  const limit = round2(budgeted.reduce((sum, b) => sum + b.amount_limit, 0));
  const spent = round2(budgeted.reduce((sum, b) => sum + b.spent, 0));
  return { budgeted, unbudgeted, categories: rows, totals: { limit, spent, remaining: round2(limit - spent) } };
}

function renderPage(res, req, status, month, errors = {}, values = {}, editing = false) {
  const data = loadMonth(req.session.user.id, month);
  return res.status(status).render('budgets/index', {
    month,
    monthLabel: monthLabel(month),
    prevMonth: shiftMonth(month, -1),
    nextMonth: shiftMonth(month, 1),
    ...data,
    errors,
    values,
    editing,
  });
}

// Finds a budget only if it belongs to the logged-in user
function findOwn(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT * FROM budgets WHERE id = ? AND user_id = ?').get(id, req.session.user.id) || null;
}

// view a month 
router.get('/', (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : currentMonth();

  // ?edit=<category id> fills the form with that category's budget
  let values = {};
  let editing = false;
  const editId = typeof req.query.edit === 'string' ? Number(req.query.edit) : NaN;
  if (Number.isInteger(editId)) {
    const row = loadMonth(req.session.user.id, month).categories.find((c) => c.category_id === editId);
    if (row) {
      values = { category_id: String(row.category_id), amount_limit: row.amount_limit ? row.amount_limit.toFixed(2) : '' };
      editing = row.budget_id !== null;
    }
  }
  renderPage(res, req, 200, month, {}, values, editing);
});

// set or change a budget 
router.post('/', budgetRules, (req, res) => {
  const result = validationResult(req);
  const { month, category_id, amount_limit } = req.body;

  if (!result.isEmpty()) {
    const shownMonth = isMonth(month) ? month : currentMonth();
    return renderPage(res, req, 422, shownMonth, result.mapped(), { category_id, amount_limit });
  }

  // One budget per category and month: saving again changes the limit
  db.prepare(
    `INSERT INTO budgets (user_id, category_id, month, amount_limit) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, category_id, month) DO UPDATE SET amount_limit = excluded.amount_limit`
  ).run(req.session.user.id, Number(category_id), month, Number(amount_limit));

  req.session.flash = { type: 'success', message: 'Budget saved.' };
  res.redirect(`/budgets?month=${month}`);
});

// remove a budget 
router.post('/:id/delete', (req, res) => {
  const budget = findOwn(req);
  if (!budget) return res.status(404).render('errors/404');

  db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(budget.id, req.session.user.id);
  req.session.flash = { type: 'success', message: 'Budget removed.' };
  res.redirect(`/budgets?month=${budget.month}`);
});

module.exports = router;