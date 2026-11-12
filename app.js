require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const { requireRole } = require('./middleware/auth');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Helpers available in every view
app.locals.money = (n) =>
  'R ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
app.locals.fmtDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProduction) app.set('trust proxy', 1); // needed behind Render/Railway for secure cookies

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// sessions
if (!process.env.SESSION_SECRET && isProduction) {
  throw new Error('SESSION_SECRET must be set in production');
}
app.use(
  session({
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // JavaScript in the browser cannot read the cookie
      sameSite: 'lax', // basic protection against cross-site form posts
      secure: isProduction, // https only in production
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// Make the logged-in user and one-time flash message available in every view
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// routes
app.get('/', (req, res) => res.render('index'));
app.use('/', require('./routes/auth'));
app.get('/dashboard', requireRole('user'), (req, res) => {
  const categories = db
    .prepare('SELECT id, name FROM categories WHERE user_id = ? ORDER BY name')
    .all(req.session.user.id);
  res.render('dashboard', { categories });
});

app.use('/categories', require('./routes/categories'));
app.use('/transactions', require('./routes/transactions'));
app.get('/admin', requireRole('admin'), (req, res) => res.render('admin/stats'));

// errors
app.use((req, res) => res.status(404).render('errors/404'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errors/500');
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Running on http://localhost:${port}`));
}

module.exports = app; // lets Supertest test the app without starting a server