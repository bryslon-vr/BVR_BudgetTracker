const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const DEFAULT_CATEGORIES = require('../db/defaults');
const { redirectIfLoggedIn, homePathFor } = require('../middleware/auth');

const router = express.Router();

// A real-looking hash used when the email is unknown, so login takes the same time either way
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const registerRules = [
  body('name')
    .trim()
    .notEmpty().withMessage('Please enter your name.').bail()
    .isLength({ max: 80 }).withMessage('Name must be 80 characters or fewer.'),
  body('email')
    .trim().toLowerCase()
    .isEmail().withMessage('Please enter a valid email address.').bail()
    .custom((value) => {
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(value);
      if (existing) throw new Error('An account with this email already exists.');
      return true;
    }),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.').bail()
    .matches(/^(?=.*[A-Za-z])(?=.*\d).+$/).withMessage('Password must include at least one letter and one number.'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match.'),
];

const loginRules = [
  body('email').trim().toLowerCase().notEmpty().withMessage('Please enter your email.'),
  body('password').notEmpty().withMessage('Please enter your password.'),
];

// register
router.get('/register', redirectIfLoggedIn, (req, res) => {
  res.render('auth/register', { errors: {}, values: {} });
});

router.post('/register', redirectIfLoggedIn, registerRules, (req, res) => {
  const result = validationResult(req);
  const { name, email } = req.body;

  if (!result.isEmpty()) {
    return res.status(422).render('auth/register', {
      errors: result.mapped(),
      values: { name, email }, // never send passwords back to the page
    });
  }

    const hash = bcrypt.hashSync(req.body.password, 10);
  const createUser = db.transaction(() => {
    const userId = db
      .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')")
      .run(name, email, hash).lastInsertRowid;
    const addCategory = db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)');
    DEFAULT_CATEGORIES.forEach((c) => addCategory.run(userId, c));
    return userId;
  });
  const userId = createUser();

  // Log the new user in straight away (new session id, like a normal login)
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: Number(userId), name, email, role: 'user' };
    req.session.flash = { type: 'success', message: `Welcome, ${name}! Your account has been created.` };
    req.session.save(() => res.redirect(homePathFor(req.session.user)));
  });
});

// login
router.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('auth/login', { errors: {}, values: {} });
});

router.post('/login', redirectIfLoggedIn, loginRules, (req, res) => {
  const result = validationResult(req);
  const { email } = req.body;

  if (!result.isEmpty()) {
    return res.status(422).render('auth/login', { errors: result.mapped(), values: { email } });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const passwordOk = bcrypt.compareSync(req.body.password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !passwordOk) {
    // Same message for "no such email" and "wrong password" so attackers learn nothing
    return res.status(401).render('auth/login', {
      errors: { form: { msg: 'Invalid email or password.' } },
      values: { email },
    });
  }

  // New session id after login (prevents session fixation)
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    req.session.save(() => res.redirect(homePathFor(req.session.user)));
  });
});

// logout
router.post('/logout', (req, res) => {
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.flash = { type: 'success', message: 'You have been logged out.' };
    req.session.save(() => res.redirect('/login'));
  });
});

module.exports = router;