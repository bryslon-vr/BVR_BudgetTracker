// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');

const admin = { name: 'Admin User', email: 'admin@example.com', password: 'Admin1234!' };
const user = { name: 'Normal User', email: 'user@example.com', password: 'User1234!' };

function addUser({ name, email, password }, role) {
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role);
}

// Returns an agent that is already logged in (keeps the session cookie)
async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  addUser(admin, 'admin');
  addUser(user, 'user');
});

describe('role-based access', () => {
  test('a normal user is blocked (403) from the admin page', async () => {
    const agent = await loginAs(user);
    const res = await agent.get('/admin');
    expect(res.status).toBe(403);
    expect(res.text).toContain('Not allowed');
  });

  test('an admin can open the admin page', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('usage statistics');
  });

  test('an admin is blocked (403) from the user dashboard', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/dashboard');
    expect(res.status).toBe(403);
  });

  test('a logged-out visitor is sent to the login page for admin pages', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('redirect after login', () => {
  test('an admin lands on /admin', async () => {
    const res = await request(app).post('/login').type('form').send({ email: admin.email, password: admin.password });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
  });

  test('a normal user lands on /dashboard', async () => {
    const res = await request(app).post('/login').type('form').send({ email: user.email, password: user.password });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  test('a logged-in admin visiting /login is sent to /admin', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
  });
});

describe('navigation', () => {
  test('a normal user sees the user menu and not the admin menu', async () => {
    const agent = await loginAs(user);
    const res = await agent.get('/dashboard');
    expect(res.text).toContain('Categories');
    expect(res.text).not.toContain('Statistics');
  });

  test('an admin sees the admin menu and not the user menu', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/admin');
    expect(res.text).toContain('Statistics');
    expect(res.text).not.toContain('Categories');
  });
});
