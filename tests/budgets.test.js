// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { isMonth, currentMonth, shiftMonth, monthLabel } = require('../utils/months');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };
const admin = { name: 'Admin Test', email: 'admin@example.com', password: 'Password1' };

const addUser = ({ name, email, password }, role = 'user') =>
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const addTx = (userId, categoryId, type, amount, date) =>
  db.prepare('INSERT INTO transactions (user_id, category_id, type, amount, date) VALUES (?, ?, ?, ?, ?)')
    .run(userId, categoryId, type, amount, date);
const addBudget = (userId, categoryId, month, limit) =>
  db.prepare('INSERT INTO budgets (user_id, category_id, month, amount_limit) VALUES (?, ?, ?, ?)')
    .run(userId, categoryId, month, limit).lastInsertRowid;
const budgetsFor = (userId) => db.prepare('SELECT * FROM budgets WHERE user_id = ?').all(userId);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

describe('month helpers', () => {
  test('shiftMonth moves across the year boundary', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', 0)).toBe('2026-11');
  });
  test('monthLabel gives a readable name', () => {
    expect(monthLabel('2026-11')).toBe('November 2026');
  });
  test('isMonth only accepts YYYY-MM', () => {
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(isMonth(['2026-11'])).toBe(false);
    expect(isMonth(undefined)).toBe(false);
  });
});

let janeId, samId, groceries, rent, samCat;

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  addUser(admin, 'admin');
  groceries = addCategory(janeId, 'Groceries');
  rent = addCategory(janeId, 'Rent');
  samCat = addCategory(samId, 'SamCat');
});

describe('spent versus remaining', () => {
  beforeEach(() => {
    addBudget(janeId, groceries, '2026-11', 100);
    addTx(janeId, groceries, 'expense', 60.25, '2026-11-02');
    addTx(janeId, groceries, 'expense', 25.25, '2026-11-20');
    addTx(janeId, groceries, 'income', 500, '2026-11-05'); // income is not spending
    addTx(janeId, groceries, 'expense', 999, '2026-10-31'); // other month
    addTx(janeId, groceries, 'expense', 999, '2026-12-01'); // other month
  });

  test('counts only this month\'s expenses', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.status).toBe(200);
    expect(res.text).toContain('R 85.50 of R 100.00');
    expect(res.text).toContain('R 14.50 left');
    expect(res.text).toContain('85% used');
  });

  test('shows how much a budget is exceeded by', async () => {
    addTx(janeId, groceries, 'expense', 30, '2026-11-25');
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).toContain('Over by R 15.50');
    expect(res.text).toContain('115% used');
    expect(res.text).toContain('width: 100%'); // the bar never grows past full
  });

  test('shows the monthly totals', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).toContain('Budgeted');
    expect(res.text).toContain('R 100.00');
    expect(res.text).toContain('R 85.50');
  });

  test('a month with no budgets says so', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-09');
    expect(res.text).toContain('No budgets set for this month yet.');
  });

  test('categories without a budget are offered below the list', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).toContain('Categories without a budget');
    expect(res.text).toContain(`edit=${rent}`);
  });

  test('has previous and next month links', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-12');
    expect(res.text).toContain('December 2026');
    expect(res.text).toContain('month=2026-11');
    expect(res.text).toContain('month=2027-01');
  });

  test('a bad month in the address falls back to the current month', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=banana');
    expect(res.status).toBe(200);
    expect(res.text).toContain(monthLabel(currentMonth()));
  });
});

describe('setting a budget', () => {
  test('creates a budget for the month', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/budgets').type('form').send({ month: '2026-11', category_id: String(rent), amount_limit: '6500' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/budgets?month=2026-11');
    expect(budgetsFor(janeId)).toMatchObject([{ category_id: rent, month: '2026-11', amount_limit: 6500 }]);
  });

  test('saving again changes the limit instead of adding a second budget', async () => {
    const agent = await loginAs(jane);
    await agent.post('/budgets').type('form').send({ month: '2026-11', category_id: String(rent), amount_limit: '6500' });
    await agent.post('/budgets').type('form').send({ month: '2026-11', category_id: String(rent), amount_limit: '7000,50' });
    const all = budgetsFor(janeId);
    expect(all).toHaveLength(1);
    expect(all[0].amount_limit).toBe(7000.5);
  });

  test('the same category can have different budgets in different months', async () => {
    const agent = await loginAs(jane);
    await agent.post('/budgets').type('form').send({ month: '2026-11', category_id: String(rent), amount_limit: '100' });
    await agent.post('/budgets').type('form').send({ month: '2026-12', category_id: String(rent), amount_limit: '200' });
    expect(budgetsFor(janeId)).toHaveLength(2);
  });

  test.each([
    ['0', 'The limit must be greater than 0.'],
    ['-5', 'Enter an amount like 1500 or 1500.50.'],
    ['abc', 'Enter an amount like 1500 or 1500.50.'],
    ['', 'Please enter a monthly limit.'],
  ])('rejects the limit "%s"', async (amount_limit, message) => {
    const agent = await loginAs(jane);
    const res = await agent.post('/budgets').type('form').send({ month: '2026-11', category_id: String(rent), amount_limit });
    expect(res.status).toBe(422);
    expect(res.text).toContain(message);
    expect(budgetsFor(janeId)).toHaveLength(0);
  });

  test('rejects an invalid month', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/budgets').type('form').send({ month: '2026-13', category_id: String(rent), amount_limit: '100' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Choose a valid month.');
    expect(budgetsFor(janeId)).toHaveLength(0);
  });

  test('rejects another user\'s category', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/budgets').type('form').send({ month: '2026-11', category_id: String(samCat), amount_limit: '100' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please choose one of your categories.');
    expect(budgetsFor(janeId)).toHaveLength(0);
    expect(budgetsFor(samId)).toHaveLength(0);
  });

  test('the edit link fills the form with the current limit', async () => {
    addBudget(janeId, rent, '2026-11', 6500);
    const agent = await loginAs(jane);
    const res = await agent.get(`/budgets?month=2026-11&edit=${rent}`);
    expect(res.text).toContain('Change a budget');
    expect(res.text).toContain('value="6500.00"');
  });
});

describe('removing and access', () => {
  test('a user can remove their own budget', async () => {
    const id = addBudget(janeId, rent, '2026-11', 100);
    const agent = await loginAs(jane);
    const res = await agent.post(`/budgets/${id}/delete`);
    expect(res.status).toBe(302);
    expect(budgetsFor(janeId)).toHaveLength(0);
  });

  test('a user cannot remove another user\'s budget', async () => {
    const id = addBudget(samId, samCat, '2026-11', 100);
    const agent = await loginAs(jane);
    const res = await agent.post(`/budgets/${id}/delete`);
    expect(res.status).toBe(404);
    expect(budgetsFor(samId)).toHaveLength(1);
  });

  test('another user\'s budgets are never shown', async () => {
    addBudget(samId, samCat, '2026-11', 4321);
    const agent = await loginAs(jane);
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).not.toContain('SamCat');
    expect(res.text).not.toContain('4,321.00');
  });

  test('an admin is blocked (403)', async () => {
    const agent = await loginAs(admin);
    expect((await agent.get('/budgets')).status).toBe(403);
    expect((await agent.post('/budgets').type('form').send({})).status).toBe(403);
  });

  test('a logged-out visitor is sent to the login page', async () => {
    const res = await request(app).get('/budgets');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});