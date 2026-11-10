const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('user')); // only normal users manage categories

// Validation for the category name (used when adding and when renaming)
const nameRule = body('name')
  .trim()
  .notEmpty().withMessage('Please enter a category name.').bail()
  .isLength({ max: 40 }).withMessage('Category name must be 40 characters or fewer.').bail()
  .custom((value, { req }) => {
    const existing = db
      .prepare('SELECT id FROM categories WHERE user_id = ? AND name = ?')
      .get(req.session.user.id, value); // name column ignores capital letters
    if (existing && String(existing.id) !== String(req.params.id)) {
      throw new Error('You already have a category with this name.');
    }
    return true;
  });

// The logged-in user's categories, each with how many transactions use it
function listCategories(userId) {
  return db
    .prepare(
      `SELECT c.id, c.name, COUNT(t.id) AS tx_count
         FROM categories c
         LEFT JOIN transactions t ON t.category_id = c.id
        WHERE c.user_id = ?
        GROUP BY c.id
        ORDER BY c.name`
    )
    .all(userId);
}

// Finds a category only if it belongs to the logged-in user
function findOwn(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, req.session.user.id) || null;
}

const notFound = (res) => res.status(404).render('errors/404');

// list and add
router.get('/', (req, res) => {
  res.render('categories/index', { categories: listCategories(req.session.user.id), errors: {}, values: {} });
});

router.post('/', nameRule, (req, res) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(422).render('categories/index', {
      categories: listCategories(req.session.user.id),
      errors: result.mapped(),
      values: { name: req.body.name },
    });
  }
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(req.session.user.id, req.body.name);
  req.session.flash = { type: 'success', message: `Category "${req.body.name}" added.` };
  res.redirect('/categories');
});

// edit 
router.get('/:id/edit', (req, res) => {
  const category = findOwn(req);
  if (!category) return notFound(res);
  res.render('categories/form', { category, errors: {}, values: { name: category.name } });
});

router.post('/:id', nameRule, (req, res) => {
  const category = findOwn(req);
  if (!category) return notFound(res);

  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(422).render('categories/form', { category, errors: result.mapped(), values: { name: req.body.name } });
  }
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(req.body.name, category.id);
  req.session.flash = { type: 'success', message: 'Category updated.' };
  res.redirect('/categories');
});

// delete 
router.post('/:id/delete', (req, res) => {
  const category = findOwn(req);
  if (!category) return notFound(res);

  const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?').get(category.id).n;
  if (used > 0) {
    req.session.flash = {
      type: 'danger',
      message: `"${category.name}" cannot be deleted because it has ${used} transaction${used === 1 ? '' : 's'}.`,
    };
    return res.redirect('/categories');
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
  req.session.flash = { type: 'success', message: `Category "${category.name}" deleted.` };
  res.redirect('/categories');
});

module.exports = router;