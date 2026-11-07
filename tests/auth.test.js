// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');

const validUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'Password1',
    confirmPassword: 'Password1',
};

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
});

describe('registration', () => {
  test('rejects an invalid email with a clear message', async () => {
    const res = await request(app).post('/register').type('form').send({ ...validUser, email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please enter a valid email address.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
  });

  test('rejects a password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/register').type('form')
      .send({ ...validUser, password: 'Ab1', confirmPassword: 'Ab1' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Password must be at least 8 characters.');
  });

  test('rejects mismatching passwords', async () => {
    const res = await request(app).post('/register').type('form').send({ ...validUser, confirmPassword: 'Different1' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Passwords do not match.');
  });

  test('stores a hashed password, never the plain text', async () => {
    const res = await request(app).post('/register').type('form').send(validUser);
    expect(res.status).toBe(302);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(validUser.email);
    expect(user.password_hash).not.toBe(validUser.password);
    expect(user.password_hash.startsWith('$2')).toBe(true);
    expect(bcrypt.compareSync(validUser.password, user.password_hash)).toBe(true);
  });

  test('rejects a duplicate email, even with different capitals', async () => {
    await request(app).post('/register').type('form').send(validUser);
    const res = await request(app).post('/register').type('form').send({ ...validUser, email: 'TEST@example.com' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('An account with this email already exists.');
  });

  test('gives a new user the default categories', async () => {
    await request(app).post('/register').type('form').send(validUser);
    const user = db.prepare('SELECT id FROM users').get();
    const n = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id = ?').get(user.id).n;
    expect(n).toBe(require('../db/defaults').length);
  });

    test('registering logs the user in straight away', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/register').type('form').send(validUser);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');

    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Welcome, Test User');
  });
});

describe('login and logout', () => {
  beforeEach(async () => {
    await request(app).post('/register').type('form').send(validUser);
  });

  test('wrong password shows a generic error', async () => {
    const res = await request(app).post('/login').type('form').send({ email: validUser.email, password: 'WrongPass1' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid email or password.');
  });

  test('unknown email shows the same generic error', async () => {
    const res = await request(app).post('/login').type('form').send({ email: 'nobody@example.com', password: 'Password1' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid email or password.');
  });

  test('protected page redirects to login when logged out', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('user can log in, see the dashboard, then log out', async () => {
    const agent = request.agent(app); // keeps the session cookie between requests

    const login = await agent.post('/login').type('form').send({ email: validUser.email, password: validUser.password });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/dashboard');

    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Welcome, Test User');

    const logout = await agent.post('/logout');
    expect(logout.status).toBe(302);

    const after = await agent.get('/dashboard');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/login');
  });
});

describe('pages', () => {
  test.each(['/', '/login', '/register'])('%s loads', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });

  test('unknown page shows the 404 page', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Page not found');
  });
});