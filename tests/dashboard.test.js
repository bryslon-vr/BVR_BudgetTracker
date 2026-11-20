// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { currentMonth, shiftMonth } = require('../utils/months');
const { monthTotals, groupTop, spendingByCategory } = require('../utils/dashboardData');

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

const month = currentMonth();
const day = `${month}-01`;
let janeId, samId, salary, groceries, rent, samCat, agent;

beforeEach(async () => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  salary = addCategory(janeId, 'Salary');
  groceries = addCategory(janeId, 'Groceries');
  rent = addCategory(janeId, 'Rent');
  samCat = addCategory(samId, 'SamCat');
  agent = await loginAs(jane);
});

describe('groupTop', () => {
  const rows = [
    { name: 'A', total: 100 }, { name: 'B', total: 90 }, { name: 'C', total: 80 },
    { name: 'D', total: 70 }, { name: 'E', total: 60 }, { name: 'F', total: 50 }, { name: 'G', total: 40.5 },
  ];
  test('leaves a short list alone', () => {
    expect(groupTop(rows.slice(0, 6), 6)).toHaveLength(6);
  });
  test('merges the smallest slices into Other', () => {
    const grouped = groupTop(rows, 6);
    expect(grouped).toHaveLength(6);
    expect(grouped.map((r) => r.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other']);
    expect(grouped[5].total).toBe(90.5); // F + G
  });
});

describe('monthTotals and spendingByCategory', () => {
  beforeEach(() => {
    addTx(janeId, salary, 'income', 1000, day);
    addTx(janeId, groceries, 'expense', 200.25, day);
    addTx(janeId, rent, 'expense', 300, day);
    addTx(janeId, groceries, 'expense', 99.75, day);
    addTx(janeId, groceries, 'expense', 5000, `${shiftMonth(month, -1)}-15`); // other month
    addTx(samId, samCat, 'expense', 7777, day);                                // other user
  });

  test('adds up this month for this user only', () => {
    expect(monthTotals(janeId, month)).toEqual({ income: 1000, expense: 600, balance: 400 });
  });

  test('groups spending by category, biggest first, with shares', () => {
    const { slices, total } = spendingByCategory(janeId, month);
    expect(total).toBe(600);
    expect(slices).toEqual([
      { name: 'Groceries', total: 300, percent: 50 },
      { name: 'Rent', total: 300, percent: 50 },
    ]);
  });

  test('income is not counted as spending', () => {
    expect(spendingByCategory(janeId, month).slices.map((s) => s.name)).not.toContain('Salary');
  });

  test('a month with nothing gives empty results', () => {
    expect(monthTotals(janeId, '2000-01')).toEqual({ income: 0, expense: 0, balance: 0 });
    expect(spendingByCategory(janeId, '2000-01')).toEqual({ slices: [], total: 0 });
  });
});

describe('the dashboard page', () => {
  test('shows the budget bubbles', async () => {
    addBudget(janeId, groceries, month, 1000);
    addTx(janeId, groceries, 'expense', 250, day);
    const res = await agent.get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Budget this month');
    expect(res.text).toMatch(/Spent<\/span><strong>R 250<\/strong>/);
    expect(res.text).toMatch(/Budget limit<\/span><strong>R 1,000<\/strong>/);
    expect(res.text).toMatch(/Remaining<\/span><strong>R 750<\/strong>/);
  });

  test('shows a negative remaining amount with a minus sign', async () => {
    addBudget(janeId, groceries, month, 100);
    addTx(janeId, groceries, 'expense', 150, day);
    const res = await agent.get('/dashboard');
    expect(res.text).toMatch(/Remaining<\/span><strong>-R 50<\/strong>/);
  });

  test('with no budgets the bubbles are zero and a hint is shown', async () => {
    const res = await agent.get('/dashboard');
    expect(res.text).toMatch(/Budget limit<\/span><strong>R 0<\/strong>/);
    expect(res.text).toContain('Set a budget to see how much is left.');
  });

  test('shows income, expenses and balance for the month', async () => {
    addTx(janeId, salary, 'income', 1000, day);
    addTx(janeId, groceries, 'expense', 400.5, day);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('+R 1,000.00');
    expect(res.text).toContain('-R 400.50');
    expect(res.text).toContain('R 599.50');
  });

  test('a negative balance has a minus sign', async () => {
    addTx(janeId, groceries, 'expense', 50, day);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('-R 50.00');
  });

  test('lists each category in the spending chart with its amount and share', async () => {
    addTx(janeId, groceries, 'expense', 300, day);
    addTx(janeId, rent, 'expense', 100, day);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('Spending by category');
    expect(res.text).toContain('R 300.00 &middot; 75%');
    expect(res.text).toContain('R 100.00 &middot; 25%');
    expect(res.text).toContain('id="spendingChart"');
  });

  test('passes the chart numbers to the page as JSON', async () => {
    addTx(janeId, groceries, 'expense', 300, day);
    const res = await agent.get('/dashboard');
    const json = res.text.match(/<script id="chart-data" type="application\/json">(.*?)<\/script>/s)[1];
    expect(JSON.parse(json)).toEqual({ labels: ['Groceries'], values: [300] });
  });

  test('a category name cannot break out of the chart data', async () => {
    const evil = addCategory(janeId, '</script><b>x');
    addTx(janeId, evil, 'expense', 10, day);
    const res = await agent.get('/dashboard');
    expect(res.text).not.toContain('</script><b>x');
    expect(res.text).toContain('\\u003c/script>');
    const json = res.text.match(/<script id="chart-data" type="application\/json">(.*?)<\/script>/s)[1];
    expect(JSON.parse(json).labels).toEqual(['</script><b>x']);
  });

  test('many categories are grouped into Other', async () => {
    for (let i = 1; i <= 8; i++) addTx(janeId, addCategory(janeId, `Cat${i}`), 'expense', 100 - i, day);
    const res = await agent.get('/dashboard');
    const json = res.text.match(/<script id="chart-data" type="application\/json">(.*?)<\/script>/s)[1];
    const chart = JSON.parse(json);
    expect(chart.labels).toEqual(['Cat1', 'Cat2', 'Cat3', 'Cat4', 'Cat5', 'Other']);
    expect(chart.values[5]).toBe(94 + 93 + 92); // Cat6 + Cat7 + Cat8
  });

  test('shows a message when nothing was spent this month', async () => {
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('No expenses recorded this month yet.');
    expect(res.text).not.toContain('id="spendingChart"');
  });

  test('never includes another user\'s numbers', async () => {
    addTx(samId, samCat, 'expense', 7777, day);
    const res = await agent.get('/dashboard');
    expect(res.text).not.toContain('SamCat');
    expect(res.text).not.toContain('7,777');
  });
});