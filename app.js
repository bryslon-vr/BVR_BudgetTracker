require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const { currentMonth, monthLabel } = require('./utils/months');
const { loadMonth } = require('./utils/budgetData');
const { budgetAlerts } = require('./utils/budgetStatus');
const { monthTotals, spendingByCategory, incomeVsExpenses } = require('./utils/dashboardData');
const { adminStats, MIN_USERS_FOR_CATEGORY } = require('./utils/adminStats');
const { requireRole } = require('./middleware/auth');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

app.locals.moneyShort = (n) => 'R ' + Math.round(Number(n)).toLocaleString('en-US');

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

app.use(express.urlencoded({ extended: false }));

// Every form field must be plain text. A repeated field (date=a&date=b) or a nested one (note[a]=1)
// is not something our forms send, so it is refused instead of crashing the page.
app.use((req, res, next) => {
  const tooComplex = Object.values(req.body || {}).some((value) => typeof value !== 'string');
  if (tooComplex) return res.status(400).render('errors/400');
  next();
});
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
  const userId = req.session.user.id;
  const categories = db.prepare('SELECT id, name FROM categories WHERE user_id = ? ORDER BY name').all(userId);
  const month = currentMonth();
  const { budgeted, totals: budgetTotals } = loadMonth(userId, month);
  const spending = spendingByCategory(userId, month);
  const trend = incomeVsExpenses(userId, month, 6);
  // Budgets shown on the dashboard: the ones closest to (or over) their limit first
  const budgetList = [...budgeted].sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name)).slice(0, 6);
  res.render('dashboard', {
    categories,
    monthLabel: monthLabel(month),
    budgetCount: budgeted.length,
    budgetTotals,
    alerts: budgetAlerts(budgeted),
    monthTotals: monthTotals(userId, month),
    spending,
    chart: { labels: spending.slices.map((s) => s.name), values: spending.slices.map((s) => s.total) },
    trend,
    trendChart: { labels: trend.map((t) => t.label), income: trend.map((t) => t.income), expense: trend.map((t) => t.expense) },
    budgetList,
  });
});

app.use('/categories', require('./routes/categories'));
app.use('/transactions', require('./routes/transactions'));
app.use('/budgets', require('./routes/budgets'));
app.get('/admin', requireRole('admin'), (req, res) => {
  res.render('admin/stats', { stats: adminStats(currentMonth()), minUsers: MIN_USERS_FOR_CATEGORY });
});

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