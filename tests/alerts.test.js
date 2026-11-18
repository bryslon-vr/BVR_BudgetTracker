// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { currentMonth } = require('../utils/months');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };

const addUser = ({ name, email, password }) =>
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const addTx = (userId, categoryId, type, amount, date) =>
  db.prepare('INSERT INTO transactions (user_id, category_id, type, amount, date) VALUES (?, ?, ?, ?, ?)')
    .run(userId, categoryId, type, amount, date).lastInsertRowid;
const addBudget = (userId, categoryId, month, limit) =>
  db.prepare('INSERT INTO budgets (user_id, category_id, month, amount_limit) VALUES (?, ?, ?, ?)')
    .run(userId, categoryId, month, limit);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

let janeId, groceries, rent, travel, agent;
const expense = (categoryId, amount, date = '2026-11-10') => ({
  type: 'expense', amount: String(amount), date, category_id: String(categoryId), note: '',
});

beforeEach(async () => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  groceries = addCategory(janeId, 'Groceries');
  rent = addCategory(janeId, 'Rent');
  travel = addCategory(janeId, 'Travel'); // never gets a budget
  agent = await loginAs(jane);
});

describe('coloured budget bars', () => {
  beforeEach(() => {
    addBudget(janeId, groceries, '2026-11', 100); // ok
    addBudget(janeId, rent, '2026-11', 100);      // warning
    addTx(janeId, groceries, 'expense', 50, '2026-11-02');
    addTx(janeId, rent, 'expense', 85, '2026-11-02');
  });

  test('shows the status in words as well as colour', async () => {
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).toContain('On track');
    expect(res.text).toContain('Almost at limit');
    expect(res.text).toContain('class="progress-bar warn"');
  });

  test('an exceeded budget gets the over class and label', async () => {
    addTx(janeId, rent, 'expense', 30, '2026-11-03');
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).toContain('Over budget');
    expect(res.text).toContain('class="progress-bar over"');
  });

  test('a budget under 80% has no warning colour', async () => {
    db.exec('DELETE FROM budgets WHERE category_id = ' + rent);
    const res = await agent.get('/budgets?month=2026-11');
    expect(res.text).not.toContain('progress-bar warn');
    expect(res.text).not.toContain('progress-bar over');
  });
});

describe('alerts after saving an expense', () => {
  beforeEach(() => addBudget(janeId, groceries, '2026-11', 100));

  test('an expense that reaches 80% shows a warning on the next page', async () => {
    const res = await agent.post('/transactions').type('form').send(expense(groceries, 85));
    expect(res.status).toBe(302);
    const next = await agent.get('/transactions');
    expect(next.text).toContain('Transaction added.');
    expect(next.text).toContain('Heads up: Groceries has used 85% of its November 2026 budget.');
    expect(next.text).toContain('alert-warning');
  });

  test('an expense that passes 100% shows an over budget message', async () => {
    await agent.post('/transactions').type('form').send(expense(groceries, 120));
    const next = await agent.get('/transactions');
    expect(next.text).toContain('Groceries is over its November 2026 budget (120% used).');
    expect(next.text).toContain('alert-danger');
  });

  test('exactly 80% already warns, and 79.99 does not', async () => {
    await agent.post('/transactions').type('form').send(expense(groceries, 79.99));
    expect((await agent.get('/transactions')).text).not.toContain('Heads up');
    await agent.post('/transactions').type('form').send(expense(groceries, 0.01));
    expect((await agent.get('/transactions')).text).toContain('has used 80%');
  });

  test('an expense well under the limit shows no warning', async () => {
    await agent.post('/transactions').type('form').send(expense(groceries, 20));
    const next = await agent.get('/transactions');
    expect(next.text).toContain('Transaction added.');
    expect(next.text).not.toContain('Heads up');
    expect(next.text).not.toContain('over its');
  });

  test('income never triggers a warning', async () => {
    addTx(janeId, groceries, 'expense', 90, '2026-11-02');
    await agent.post('/transactions').type('form').send({ ...expense(groceries, 50), type: 'income' });
    expect((await agent.get('/transactions')).text).not.toContain('Heads up');
  });

  test('a category without a budget never warns', async () => {
    await agent.post('/transactions').type('form').send(expense(travel, 99999));
    const next = await agent.get('/transactions');
    expect(next.text).toContain('Transaction added.');
    expect(next.text).not.toContain('Heads up');
    expect(next.text).not.toContain('over its');
  });

  test('only the budget of the transaction\'s own month counts', async () => {
    await agent.post('/transactions').type('form').send(expense(groceries, 500, '2026-10-10'));
    expect((await agent.get('/transactions')).text).not.toContain('Heads up');
  });

  test('editing a transaction can warn too', async () => {
    const id = addTx(janeId, groceries, 'expense', 10, '2026-11-02');
    await agent.post(`/transactions/${id}`).type('form').send(expense(groceries, 95));
    const next = await agent.get('/transactions');
    expect(next.text).toContain('Transaction updated.');
    expect(next.text).toContain('Heads up: Groceries has used 95%');
  });
});

describe('dashboard alerts', () => {
  const month = currentMonth();
  const day = `${month}-01`;

  test('shows a prompt when there are no budgets this month', async () => {
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('You have not set any budgets for this month.');
  });

  test('says everything is fine when all budgets are on track', async () => {
    addBudget(janeId, groceries, month, 100);
    addTx(janeId, groceries, 'expense', 10, day);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('All your budgets are on track this month.');
  });

  test('lists budgets at 80% or more, worst first', async () => {
    addBudget(janeId, groceries, month, 100);
    addBudget(janeId, rent, month, 100);
    addTx(janeId, groceries, 'expense', 85, day);
    addTx(janeId, rent, 'expense', 120, day);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('Rent</strong> is over budget (120% used, over by R 20.00)');
    expect(res.text).toContain('Groceries</strong> has used 85% of its budget (R 15.00 left)');
    expect(res.text.indexOf('Rent</strong>')).toBeLessThan(res.text.indexOf('Groceries</strong>'));
  });

  test('ignores budgets from other months', async () => {
    addBudget(janeId, groceries, '2020-01', 100);
    addTx(janeId, groceries, 'expense', 500, '2020-01-05');
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('You have not set any budgets for this month.');
  });
});