// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { currentMonth, shiftMonth, lastMonths, shortMonth } = require('../utils/months');
const { incomeVsExpenses } = require('../utils/dashboardData');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };

const addUser = ({ name, email, password }) =>
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const addTx = (userId, categoryId, type, amount, date) =>
  db.prepare('INSERT INTO transactions (user_id, category_id, type, amount, date) VALUES (?, ?, ?, ?, ?)')
    .run(userId, categoryId, type, amount, date);
const addBudget = (userId, categoryId, month, limit) =>
  db.prepare('INSERT INTO budgets (user_id, category_id, month, amount_limit) VALUES (?, ?, ?, ?)')
    .run(userId, categoryId, month, limit);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

const trendJson = (html) =>
  JSON.parse(html.match(/<script id="trend-data" type="application\/json">(.*?)<\/script>/s)[1]);

describe('month helpers for the chart', () => {
  test('lastMonths lists the months oldest first', () => {
    expect(lastMonths('2026-11', 6)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  });
  test('lastMonths works across the year boundary', () => {
    expect(lastMonths('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  test('shortMonth gives three letters', () => {
    expect(shortMonth('2026-09')).toBe('Sep');
    expect(shortMonth('2026-11')).toBe('Nov');
  });
});

let janeId, samId, salary, groceries, samCat, agent;
const month = currentMonth();

beforeEach(async () => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  salary = addCategory(janeId, 'Salary');
  groceries = addCategory(janeId, 'Groceries');
  samCat = addCategory(samId, 'SamCat');
  agent = await loginAs(jane);
});

describe('incomeVsExpenses', () => {
  test('always returns six months, oldest first, with zeros for empty months', () => {
    const result = incomeVsExpenses(janeId, '2026-11', 6);
    expect(result.map((r) => r.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(result.every((r) => r.income === 0 && r.expense === 0)).toBe(true);
  });

  test('adds up each month separately', () => {
    addTx(janeId, salary, 'income', 1000, '2026-11-01');
    addTx(janeId, salary, 'income', 500.5, '2026-11-20');
    addTx(janeId, groceries, 'expense', 200.25, '2026-11-05');
    addTx(janeId, groceries, 'expense', 99.75, '2026-11-06');
    addTx(janeId, groceries, 'expense', 80, '2026-09-30');
    const result = incomeVsExpenses(janeId, '2026-11', 6);
    expect(result.find((r) => r.month === '2026-11')).toMatchObject({ label: 'Nov', income: 1500.5, expense: 300 });
    expect(result.find((r) => r.month === '2026-09')).toMatchObject({ income: 0, expense: 80 });
  });

  test('leaves out months outside the window and other users', () => {
    addTx(janeId, groceries, 'expense', 999, '2026-05-31'); // just before the window
    addTx(janeId, groceries, 'expense', 999, '2026-12-01'); // after the window
    addTx(samId, samCat, 'expense', 777, '2026-11-02');
    const total = incomeVsExpenses(janeId, '2026-11', 6).reduce((sum, r) => sum + r.expense, 0);
    expect(total).toBe(0);
  });

  test('includes the first and last day of the window', () => {
    addTx(janeId, groceries, 'expense', 10, '2026-06-01');
    addTx(janeId, groceries, 'expense', 20, '2026-11-30');
    const result = incomeVsExpenses(janeId, '2026-11', 6);
    expect(result[0].expense).toBe(10);
    expect(result[5].expense).toBe(20);
  });

  test('works across a year boundary', () => {
    addTx(janeId, salary, 'income', 100, '2025-12-15');
    const result = incomeVsExpenses(janeId, '2026-03', 6);
    expect(result.map((r) => r.month)[0]).toBe('2025-10');
    expect(result.find((r) => r.month === '2025-12').income).toBe(100);
  });
});

describe('the dashboard income and expenses chart', () => {
  test('passes six months of numbers to the page as JSON', async () => {
    addTx(janeId, salary, 'income', 1000, `${month}-01`);
    addTx(janeId, groceries, 'expense', 400, `${month}-02`);
    const res = await agent.get('/dashboard');
    const data = trendJson(res.text);
    expect(data.labels).toHaveLength(6);
    expect(data.labels[5]).toBe(shortMonth(month));
    expect(data.income[5]).toBe(1000);
    expect(data.expense[5]).toBe(400);
    expect(data.income.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  test('has a canvas and a table with the same numbers', async () => {
    addTx(janeId, salary, 'income', 1234.5, `${month}-01`);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('Income vs expenses');
    expect(res.text).toContain('id="trendChart"');
    expect(res.text).toContain('Show the numbers');
    expect(res.text).toContain('R 1,234.50');
  });

  test('does not include the previous month\'s other users', async () => {
    addTx(samId, samCat, 'expense', 7777, `${shiftMonth(month, -1)}-10`);
    const res = await agent.get('/dashboard');
    expect(trendJson(res.text).expense.every((v) => v === 0)).toBe(true);
  });
});

describe('the dashboard category budgets list', () => {
  test('shows each budget with its status, worst first', async () => {
    const rent = addCategory(janeId, 'Rent');
    const fun = addCategory(janeId, 'Fun');
    addBudget(janeId, groceries, month, 100); addTx(janeId, groceries, 'expense', 50, `${month}-01`);  // ok
    addBudget(janeId, rent, month, 100);      addTx(janeId, rent, 'expense', 85, `${month}-01`);       // warning
    addBudget(janeId, fun, month, 100);       addTx(janeId, fun, 'expense', 140, `${month}-01`);       // exceeded
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('Category budgets');
    expect(res.text).toContain('On track');
    expect(res.text).toContain('Almost at limit');
    expect(res.text).toContain('Over budget');
    const at = (name) => res.text.indexOf(`>${name}</span>`);
    expect(at('Fun')).toBeLessThan(at('Rent'));
    expect(at('Rent')).toBeLessThan(at('Groceries'));
    expect(res.text).toContain('class="progress-bar over"');
    expect(res.text).toContain('class="progress-bar warn"');
  });

  test('shows at most six budgets', async () => {
    for (let i = 1; i <= 8; i++) {
      const c = addCategory(janeId, `Budget${i}`);
      addBudget(janeId, c, month, 100);
      addTx(janeId, c, 'expense', i * 10, `${month}-01`);
    }
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('>Budget8</span>');
    expect(res.text).toContain('>Budget3</span>');
    expect(res.text).not.toContain('>Budget2</span>');
    expect(res.text).not.toContain('>Budget1</span>');
  });

  test('says so when there are no budgets this month', async () => {
    addBudget(janeId, groceries, '2020-01', 100);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('No budgets for this month yet.');
  });

  test('never shows another user\'s budgets', async () => {
    addBudget(samId, samCat, month, 4321);
    const res = await agent.get('/dashboard');
    expect(res.text).not.toContain('SamCat');
    expect(res.text).not.toContain('4,321.00');
  });
});