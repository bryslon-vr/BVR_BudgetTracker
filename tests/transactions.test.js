// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };
const admin = { name: 'Admin Test', email: 'admin@example.com', password: 'Password1' };

const addUser = ({ name, email, password }, role = 'user') =>
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const allTransactions = (userId) =>
  db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(userId);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

let janeId, samId, rent, samCategory;
const valid = () => ({ type: 'expense', amount: '125.50', date: '2026-11-05', category_id: String(rent), note: 'Test' });

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  addUser(admin, 'admin');
  rent = addCategory(janeId, 'Rent');
  samCategory = addCategory(samId, 'Private');
});

describe('adding a transaction', () => {
  test('saves a valid expense with the right values', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send(valid());
    expect(res.status).toBe(302);
    const [t] = allTransactions(janeId);
    expect(t).toMatchObject({ type: 'expense', amount: 125.5, date: '2026-11-05', category_id: rent, note: 'Test' });
  });

  test('accepts a comma as the decimal separator', async () => {
    const agent = await loginAs(jane);
    await agent.post('/transactions').type('form').send({ ...valid(), amount: '12,50' });
    expect(allTransactions(janeId)[0].amount).toBe(12.5);
  });

  test('an empty note is stored as nothing', async () => {
    const agent = await loginAs(jane);
    await agent.post('/transactions').type('form').send({ ...valid(), note: '   ' });
    expect(allTransactions(janeId)[0].note).toBeNull();
  });
});

describe('validation', () => {
  test.each([
    ['0', 'Amount must be greater than 0.'],
    ['-5', 'Enter an amount like 125.50'],
    ['abc', 'Enter an amount like 125.50'],
    ['10.999', 'Enter an amount like 125.50'],
    ['', 'Please enter an amount.'],
  ])('rejects the amount "%s"', async (amount, message) => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send({ ...valid(), amount });
    expect(res.status).toBe(422);
    expect(res.text).toContain(message);
    expect(allTransactions(janeId)).toHaveLength(0);
  });

  test.each(['2026-02-30', '05/11/2026', 'tomorrow', ''])('rejects the date "%s"', async (date) => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send({ ...valid(), date });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please enter a valid date.');
  });

  test('rejects a category that belongs to another user', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send({ ...valid(), category_id: String(samCategory) });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please choose one of your categories.');
    expect(allTransactions(janeId)).toHaveLength(0);
  });

  test('rejects a type that is not income or expense', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send({ ...valid(), type: 'gift' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please choose income or expense.');
  });

  test('rejects a note longer than 200 characters', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send({ ...valid(), note: 'x'.repeat(201) });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Note must be 200 characters or fewer.');
  });

  test('keeps what the user typed when there is an error', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/transactions').type('form').send({ ...valid(), amount: 'abc', note: 'Keep this note' });
    expect(res.text).toContain('Keep this note');
  });
});

describe('listing and access', () => {
  test('the list shows only the logged-in user\'s transactions', async () => {
    db.prepare("INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, 'expense', 10, '2026-11-01', 'JaneOnly')").run(janeId, rent);
    db.prepare("INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, 'expense', 10, '2026-11-01', 'SamOnly')").run(samId, samCategory);
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions');
    expect(res.text).toContain('JaneOnly');
    expect(res.text).not.toContain('SamOnly');
  });

  test('the dashboard shows the quick add card', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('Quick add');
    expect(res.text).toContain('Rent');
  });

  test('an admin is blocked (403) from transactions', async () => {
    const agent = await loginAs(admin);
    expect((await agent.get('/transactions')).status).toBe(403);
    expect((await agent.post('/transactions').type('form').send(valid())).status).toBe(403);
  });

  test('a logged-out visitor is sent to the login page', async () => {
    const res = await request(app).get('/transactions/new');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});