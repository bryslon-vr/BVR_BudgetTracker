const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const { parseStatement, MAX_ROWS } = require('../utils/csvImport');

const router = express.Router();
router.use(requireRole('user')); // only normal users import transactions

const MAX_BYTES = 1024 * 1024; // 1 MB
// The file is kept in memory only while it is read, never saved to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 },
  fileFilter: (req, file, cb) => cb(null, /\.csv$/i.test(file.originalname)),
});

const userCategories = (userId) =>
  db.prepare('SELECT id, name FROM categories WHERE user_id = ? ORDER BY name').all(userId);

function showForm(res, req, status, error = null) {
  return res.status(status).render('transactions/import', {
    categories: userCategories(req.session.user.id),
    error,
    maxRows: MAX_ROWS,
  });
}

// Rows that match a transaction the user already has (same date, type, amount and note)
function markDuplicates(userId, rows) {
  const exists = db.prepare(
    `SELECT 1 FROM transactions
      WHERE user_id = ? AND date = ? AND type = ? AND amount = ? AND COALESCE(note, '') = ? LIMIT 1`
  );
  return rows.map((r) => ({ ...r, duplicate: !!exists.get(userId, r.date, r.type, r.amount, r.note || '') }));
}

// step 1: choose a file
router.get('/', (req, res) => {
  delete req.session.importRows; // starting again clears any earlier preview
  showForm(res, req, 200);
});

// step 2: upload and preview
router.post(
  '/',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      showForm(res, req, 422, tooBig ? 'The file is larger than 1 MB. Split it into smaller files.' : 'The file could not be uploaded. Please try again.');
    });
  },
  (req, res) => {
    const userId = req.session.user.id;
    const categories = userCategories(userId);
    const defaultId = Number((req.body || {}).category_id);

    if (!req.file) return showForm(res, req, 422, 'Choose a .csv file to upload.');
    if (!categories.some((c) => c.id === defaultId)) {
      return showForm(res, req, 422, 'Choose a category for rows that do not name one.');
    }

    const result = parseStatement(req.file.buffer.toString('utf8'), categories, defaultId);
    if (result.fatal) return showForm(res, req, 422, result.fatal);

    const names = new Map(categories.map((c) => [c.id, c.name]));
    const rows = markDuplicates(userId, result.rows).map((r) => ({ ...r, categoryName: names.get(r.category_id) }));
    const fresh = rows.filter((r) => !r.duplicate);

    // Remember only what will be imported, so confirming does not need the file again
    req.session.importRows = fresh.map(({ date, type, amount, note, category_id }) => ({ date, type, amount, note, category_id }));

    res.render('transactions/import-preview', {
      fileName: req.file.originalname,
      previewRows: rows.slice(0, 20),
      totalRows: rows.length,
      newCount: fresh.length,
      duplicateCount: rows.length - fresh.length,
      problems: result.problems,
    });
  }
);

// step 3: confirm 
router.post('/confirm', (req, res) => {
  const rows = req.session.importRows;
  delete req.session.importRows; // one preview can only be imported once

  if (!Array.isArray(rows) || rows.length === 0) {
    req.session.flash = { type: 'warning', message: 'There is nothing to import. Upload a file first.' };
    return res.redirect('/transactions/import');
  }

  const userId = req.session.user.id;
  const validCategories = new Set(userCategories(userId).map((c) => c.id));
  if (rows.some((r) => !validCategories.has(r.category_id))) {
    req.session.flash = { type: 'danger', message: 'A category was deleted while you were previewing. Please upload the file again.' };
    return res.redirect('/transactions/import');
  }

  const insert = db.prepare(
    'INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => rows.forEach((r) => insert.run(userId, r.category_id, r.type, r.amount, r.date, r.note)))();

  req.session.flash = { type: 'success', message: `Imported ${rows.length} transaction${rows.length === 1 ? '' : 's'}.` };
  res.redirect('/transactions');
});

module.exports = router;