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
const addTransaction = (userId, categoryId, note = 'Original') =>
  db.prepare("INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, 'expense', 100, '2026-11-01', ?)")
    .run(userId, categoryId, note).lastInsertRowid;
const getTransaction = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

let janeId, samId, rent, food, samCategory, janeTx, samTx;
const changes = () => ({ type: 'income', amount: '250.75', date: '2026-11-09', category_id: String(food), note: 'Changed' });

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  addUser(admin, 'admin');
  rent = addCategory(janeId, 'Rent');
  food = addCategory(janeId, 'Food');
  samCategory = addCategory(samId, 'Private');
  janeTx = addTransaction(janeId, rent);
  samTx = addTransaction(samId, samCategory, 'SamOriginal');
});

describe('editing a transaction', () => {
  test('the edit form is filled in with the current values', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get(`/transactions/${janeTx}/edit`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Edit transaction');
    expect(res.text).toContain('value="100.00"');
    expect(res.text).toContain('value="Original"');
  });

  test('a user can change every field of their transaction', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post(`/transactions/${janeTx}`).type('form').send(changes());
    expect(res.status).toBe(302);
    expect(getTransaction(janeTx)).toMatchObject({
      type: 'income', amount: 250.75, date: '2026-11-09', category_id: food, note: 'Changed',
    });
  });

  test('invalid changes are rejected and nothing is saved', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post(`/transactions/${janeTx}`).type('form').send({ ...changes(), amount: '0' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Amount must be greater than 0.');
    expect(getTransaction(janeTx).amount).toBe(100);
  });

  test('a transaction cannot be moved into another user\'s category', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post(`/transactions/${janeTx}`).type('form').send({ ...changes(), category_id: String(samCategory) });
    expect(res.status).toBe(422);
    expect(getTransaction(janeTx).category_id).toBe(rent);
  });
});

describe('deleting a transaction', () => {
  test('a user can delete their own transaction', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post(`/transactions/${janeTx}/delete`);
    expect(res.status).toBe(302);
    expect(getTransaction(janeTx)).toBeUndefined();
  });

  test('the list has edit and delete buttons', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions');
    expect(res.text).toContain(`/transactions/${janeTx}/edit`);
    expect(res.text).toContain(`/transactions/${janeTx}/delete`);
  });
});

describe('ownership and access', () => {
  test('a user cannot open, edit or delete another user\'s transaction', async () => {
    const agent = await loginAs(jane);
    expect((await agent.get(`/transactions/${samTx}/edit`)).status).toBe(404);
    expect((await agent.post(`/transactions/${samTx}`).type('form').send(changes())).status).toBe(404);
    expect((await agent.post(`/transactions/${samTx}/delete`)).status).toBe(404);
    expect(getTransaction(samTx)).toMatchObject({ note: 'SamOriginal', amount: 100 });
  });

  test('an id that is not a number shows the 404 page', async () => {
    const agent = await loginAs(jane);
    expect((await agent.get('/transactions/abc/edit')).status).toBe(404);
    expect((await agent.post('/transactions/abc/delete')).status).toBe(404);
  });

  test('an admin is blocked (403) from editing and deleting', async () => {
    const agent = await loginAs(admin);
    expect((await agent.get(`/transactions/${janeTx}/edit`)).status).toBe(403);
    expect((await agent.post(`/transactions/${janeTx}/delete`)).status).toBe(403);
    expect(getTransaction(janeTx)).toBeDefined();
  });

  test('a logged-out visitor cannot delete', async () => {
    const res = await request(app).post(`/transactions/${janeTx}/delete`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect(getTransaction(janeTx)).toBeDefined();
  });
});