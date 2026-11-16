// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');

let categoryId, agent;
const good = () => `type=expense&amount=10&date=2026-11-05&category_id=${categoryId}&note=hi`;

beforeEach(async () => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  const userId = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Jane', 'jane@example.com', ?, 'user')")
    .run(bcrypt.hashSync('Password1', 10)).lastInsertRowid;
  categoryId = db.prepare("INSERT INTO categories (user_id, name) VALUES (?, 'Rent')").run(userId).lastInsertRowid;
  agent = request.agent(app);
  await agent.post('/login').type('form').send({ email: 'jane@example.com', password: 'Password1' });
});

describe('odd form input', () => {
  test('a normal transaction still works', async () => {
    const res = await agent.post('/transactions').type('form').send(good());
    expect(res.status).toBe(302);
  });

  test.each([
    ['a repeated date field', '&date=2026-11-06'],
    ['a repeated type field', '&type=income'],
    ['a repeated note field', '&note=again'],
  ])('%s gets a 400 page instead of crashing', async (name, extra) => {
    const res = await agent.post('/transactions').type('form').send(good() + extra);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid request');
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n).toBe(0);
  });

  test('a nested field name is ignored and does not crash', async () => {
    const res = await agent.post('/transactions').type('form').send(good() + '&note[a]=1');
    expect(res.status).toBe(302);
    expect(db.prepare('SELECT note FROM transactions').get().note).toBe('hi');
  });

  test('a repeated email field on the login form gets a 400 page', async () => {
    const res = await request(app).post('/login').type('form').send('email=a@b.com&email=c@d.com&password=x');
    expect(res.status).toBe(400);
  });

  test('a repeated name field on the register form gets a 400 page', async () => {
    const res = await request(app)
      .post('/register').type('form')
      .send('name=a&name=b&email=new@example.com&password=Password1&confirmPassword=Password1');
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'new@example.com'").get().n).toBe(0);
  });
});

describe('odd query strings', () => {
  test.each([
    '/transactions?from=2026-11-01&from=2026-11-02',
    '/transactions?q[a]=1',
    '/transactions?page=99999999999999999999',
    '/transactions?category=1&category=2',
  ])('%s does not crash', async (url) => {
    const res = await agent.get(url);
    expect(res.status).toBe(200);
  });
});