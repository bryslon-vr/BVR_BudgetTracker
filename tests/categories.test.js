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

function addUser({ name, email, password }, role = 'user') {
  return db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role).lastInsertRowid;
}
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const addTransaction = (userId, categoryId) =>
  db.prepare("INSERT INTO transactions (user_id, category_id, type, amount, date) VALUES (?, ?, 'expense', 50, '2026-11-01')").run(userId, categoryId);
const names = (userId) =>
  db.prepare('SELECT name FROM categories WHERE user_id = ? ORDER BY name').all(userId).map((r) => r.name);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

let janeId, samId;
beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  addUser(admin, 'admin');
});

describe('adding categories', () => {
  test('a user can add a category and see it in the list', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/categories').type('form').send({ name: 'Rent' });
    expect(res.status).toBe(302);
    expect(names(janeId)).toEqual(['Rent']);
    const list = await agent.get('/categories');
    expect(list.text).toContain('Rent');
  });

  test('an empty name is rejected with a clear message', async () => {
    const agent = await loginAs(jane);
    const res = await agent.post('/categories').type('form').send({ name: '   ' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please enter a category name.');
    expect(names(janeId)).toEqual([]);
  });

  test('a duplicate name is rejected, even with different capitals', async () => {
    addCategory(janeId, 'Rent');
    const agent = await loginAs(jane);
    const res = await agent.post('/categories').type('form').send({ name: 'rent' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('You already have a category with this name.');
    expect(names(janeId)).toEqual(['Rent']);
  });

  test('two different users can both have a category with the same name', async () => {
    addCategory(samId, 'Rent');
    const agent = await loginAs(jane);
    const res = await agent.post('/categories').type('form').send({ name: 'Rent' });
    expect(res.status).toBe(302);
    expect(names(janeId)).toEqual(['Rent']);
  });
});

describe('renaming and deleting', () => {
  test('a user can rename their category', async () => {
    const id = addCategory(janeId, 'Food');
    const agent = await loginAs(jane);
    const res = await agent.post(`/categories/${id}`).type('form').send({ name: 'Groceries' });
    expect(res.status).toBe(302);
    expect(names(janeId)).toEqual(['Groceries']);
  });

  test('a category that has transactions cannot be deleted', async () => {
    const id = addCategory(janeId, 'Rent');
    addTransaction(janeId, id);
    const agent = await loginAs(jane);
    const res = await agent.post(`/categories/${id}/delete`);
    expect(res.status).toBe(302);
    expect(names(janeId)).toEqual(['Rent']);
    const list = await agent.get('/categories');
    expect(list.text).toContain('cannot be deleted');
  });

  test('an unused category can be deleted', async () => {
    const id = addCategory(janeId, 'Hobbies');
    const agent = await loginAs(jane);
    await agent.post(`/categories/${id}/delete`);
    expect(names(janeId)).toEqual([]);
  });
});

describe('access control', () => {
  test('a user cannot rename or delete another user\'s category', async () => {
    const samCategory = addCategory(samId, 'Private');
    const agent = await loginAs(jane);
    const rename = await agent.post(`/categories/${samCategory}`).type('form').send({ name: 'Hacked' });
    const del = await agent.post(`/categories/${samCategory}/delete`);
    expect(rename.status).toBe(404);
    expect(del.status).toBe(404);
    expect(names(samId)).toEqual(['Private']);
  });

  test('another user\'s category is never shown in the list', async () => {
    addCategory(samId, 'SecretStuff');
    const agent = await loginAs(jane);
    const res = await agent.get('/categories');
    expect(res.text).not.toContain('SecretStuff');
  });

  test('an admin is blocked (403) from the categories pages', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/categories');
    expect(res.status).toBe(403);
  });

  test('a logged-out visitor is sent to the login page', async () => {
    const res = await request(app).get('/categories');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});