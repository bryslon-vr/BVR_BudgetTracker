const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('user')); // only normal users have transactions

// Validation for adding and editing a transaction
const transactionRules = [
  body('type').isIn(['income', 'expense']).withMessage('Please choose income or expense.'),
  body('amount')
    .trim()
    .customSanitizer((v) => String(v).replace(',', '.')) // accept 12,50 as well as 12.50
    .notEmpty().withMessage('Please enter an amount.').bail()
    .matches(/^\d{1,9}(\.\d{1,2})?$/).withMessage('Enter an amount like 125.50 (numbers only, up to 2 decimals).').bail()
    .custom((v) => Number(v) > 0).withMessage('Amount must be greater than 0.'),
  body('date')
    .trim()
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Please enter a valid date.').bail()
    .isISO8601({ strict: true }).withMessage('Please enter a valid date.').bail()
    .custom((v) => v >= '2000-01-01').withMessage('Date must be from the year 2000 or later.'),
  body('category_id').custom((value, { req }) => {
    const id = Number(value);
    const row = Number.isInteger(id)
      ? db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(id, req.session.user.id)
      : null;
    if (!row) throw new Error('Please choose one of your categories.'); // also blocks other users' categories
    return true;
  }),
  body('note').trim().isLength({ max: 200 }).withMessage('Note must be 200 characters or fewer.'),
];

const userCategories = (userId) =>
  db.prepare('SELECT id, name FROM categories WHERE user_id = ? ORDER BY name').all(userId);

// Finds a transaction only if it belongs to the logged-in user
function findOwn(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, req.session.user.id) || null;
}

const notFound = (res) => res.status(404).render('errors/404');

function renderForm(res, req, status, errors, values, edit = null) {
  return res.status(status).render('transactions/form', {
    heading: edit ? 'Edit transaction' : 'Add transaction',
    formAction: edit ? `/transactions/${edit.id}` : '/transactions',
    categories: userCategories(req.session.user.id),
    errors,
    values,
  });
}

// list (filters and paging come later) 
router.get('/', (req, res) => {
  const transactions = db
    .prepare(
      `SELECT t.id, t.type, t.amount, t.date, t.note, c.name AS category
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = ?
        ORDER BY t.date DESC, t.id DESC
        LIMIT 50`
    )
    .all(req.session.user.id);
  res.render('transactions/index', { transactions });
});

// add 
router.get('/new', (req, res) => renderForm(res, req, 200, {}, { type: 'expense' }));

router.post('/', transactionRules, (req, res) => {
  const result = validationResult(req);
  const { type, amount, date, category_id, note } = req.body;

  if (!result.isEmpty()) {
    return renderForm(res, req, 422, result.mapped(), { type, amount, date, category_id, note });
  }

  db.prepare(
    'INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.session.user.id, Number(category_id), type, Number(amount), date, note || null);

  req.session.flash = { type: 'success', message: 'Transaction added.' };
  res.redirect('/transactions');
});

// edit
router.get('/:id/edit', (req, res) => {
  const t = findOwn(req);
  if (!t) return notFound(res);
  const values = {
    type: t.type,
    amount: t.amount.toFixed(2),
    date: t.date,
    category_id: String(t.category_id),
    note: t.note || '',
  };
  renderForm(res, req, 200, {}, values, t);
});

router.post('/:id', transactionRules, (req, res) => {
  const t = findOwn(req);
  if (!t) return notFound(res);

  const result = validationResult(req);
  const { type, amount, date, category_id, note } = req.body;
  if (!result.isEmpty()) {
    return renderForm(res, req, 422, result.mapped(), { type, amount, date, category_id, note }, t);
  }

  db.prepare(
    'UPDATE transactions SET category_id = ?, type = ?, amount = ?, date = ?, note = ? WHERE id = ? AND user_id = ?'
  ).run(Number(category_id), type, Number(amount), date, note || null, t.id, req.session.user.id);

  req.session.flash = { type: 'success', message: 'Transaction updated.' };
  res.redirect('/transactions');
});

// delete 
router.post('/:id/delete', (req, res) => {
  const t = findOwn(req);
  if (!t) return notFound(res);

  db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(t.id, req.session.user.id);
  req.session.flash = { type: 'success', message: 'Transaction deleted.' };
  res.redirect('/transactions');
});

module.exports = router;