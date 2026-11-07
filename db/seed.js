require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const db = require('./index');
const DEFAULT_CATEGORIES = require('./defaults');

// helpers
const today = new Date();

// Formats a date as YYYY-MM-DD
function fmtDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Same input always gives the same numbers, so the demo data is repeatable
let seedValue = 42;
function rand() {
  seedValue = (seedValue * 16807) % 2147483647;
  return seedValue / 2147483647;
}
const between = (min, max) => Math.round(min + rand() * (max - min));

// 1. clear old data
const clear = db.transaction(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users','categories','transactions','budgets');");
});
clear();

// 2. users
const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');
const users = [
  { name: 'Admin User', email: 'admin@budget.test', password: 'Admin1234!', role: 'admin', demo: false },
  { name: 'Jane Demo', email: 'jane@budget.test', password: 'Demo1234!',  role: 'user',  demo: true, scale: 1 },
  { name: 'Sam Demo', email: 'sam@budget.test', password: 'Demo1234!',  role: 'user',  demo: true, scale: 0.7 },
];
users.forEach((u) => {
  u.id = insertUser.run(u.name, u.email, bcrypt.hashSync(u.password, 10), u.role).lastInsertRowid;
});

// 3. categories, transactions, budgets for the demo users
const insertCategory = db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)');
const insertTx = db.prepare(
  'INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, ?, ?, ?, ?)'
);
const insertBudget = db.prepare(
  'INSERT INTO budgets (user_id, category_id, month, amount_limit) VALUES (?, ?, ?, ?)'
);

// One entry per kind of transaction: [category, type, day of month, min, max, note]
const monthlyPlan = [
  ['Salary', 'income', 1, 18000, 18000, 'Monthly salary'],
  ['Rent', 'expense', 2, 6500, 6500, 'Rent'],
  ['Groceries', 'expense', 5, 450, 900, 'Weekly shop'],
  ['Groceries', 'expense', 12, 450, 900, 'Weekly shop'],
  ['Groceries', 'expense', 20, 450, 900, 'Weekly shop'],
  ['Transport', 'expense', 8, 300, 700, 'Fuel'],
  ['Utilities', 'expense', 10, 900, 1400, 'Electricity and water'],
  ['Entertainment', 'expense', 15, 150, 600, 'Movies and streaming'],
  ['Eating Out', 'expense', 18, 200, 650, 'Dinner out'],
  ['Health', 'expense', 22, 150, 500, 'Pharmacy'],
];

const seedDemoUser = db.transaction((user) => {
  const cat = {};
  DEFAULT_CATEGORIES.forEach((name) => {
    cat[name] = insertCategory.run(user.id, name).lastInsertRowid;
  });

  // Last 6 months, including the current one
  for (let i = 5; i >= 0; i--) {
    const first = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = first.getFullYear();
    const m = first.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const isCurrent = i === 0;

    monthlyPlan.forEach(([category, type, day, min, max, note]) => {
      // No dates in the future, and no day past the end of the month
      const d = Math.min(day, lastDay, isCurrent ? today.getDate() : lastDay);
      const amount = between(min, max) * user.scale;
      insertTx.run(user.id, cat[category], type, Math.round(amount), fmtDate(y, m, d), note);
    });
  }

  // Budgets for this month and last month, based on what was actually spent so the demo shows an OK, a warning (80%+) and an exceeded (100%+) example.
  const spentThisMonth = db.prepare(
    `SELECT c.name AS name, c.id AS id, COALESCE(SUM(t.amount), 0) AS spent
       FROM categories c
       LEFT JOIN transactions t ON t.category_id = c.id AND t.type = 'expense' AND substr(t.date, 1, 7) = ?
      WHERE c.user_id = ? AND c.name <> 'Salary'
      GROUP BY c.id`
  );
  for (let i = 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    spentThisMonth.all(month, user.id).forEach((row) => {
      let ratio = 0.55;  // comfortable
      if (row.name === 'Groceries') ratio = 0.86; // shows the 80% warning
      if (row.name === 'Entertainment') ratio = 1.15; // shows the 100% warning
      const limit = Math.max(100, Math.round(row.spent / ratio / 50) * 50);
      insertBudget.run(user.id, row.id, month, limit);
    });
  }
});

users.filter((u) => u.demo).forEach(seedDemoUser);

// 4. summary
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log('Database seeded:');
console.log(`  users: ${count('users')}`);
console.log(`  categories: ${count('categories')}`);
console.log(`  transactions: ${count('transactions')}`);
console.log(`  budgets: ${count('budgets')}`);
console.log('\nDemo logins:');
users.forEach((u) => console.log(`${u.role.padEnd(5)}  ${u.email} / ${u.password}`));