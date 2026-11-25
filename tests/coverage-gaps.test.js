// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { parseFilters } = require('../utils/transactionFilters');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };
const admin = { name: 'Admin Test', email: 'admin@example.com', password: 'Password1' };

const addUser = ({ name, email, password }, role = 'user') =>
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const categoryName = (id) => db.prepare('SELECT name FROM categories WHERE id = ?').get(id).name;

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

describe('filters: the less common mistakes', () => {
  test('an invalid To date gives an error', () => {
    const r = parseFilters({ to: '2026-02-30' }, []);
    expect(r.errors.to).toBe('Enter a valid date.');
    expect(r.filters.to).toBeUndefined();
  });

  test('a type that is not income or expense gives an error', () => {
    const r = parseFilters({ type: 'gift' }, []);
    expect(r.errors.type).toBe('Choose income or expense.');
    expect(r.filters.type).toBeUndefined();
  });

  test.each(['min', 'max'])('an invalid %s amount gives an error', (key) => {
    const r = parseFilters({ [key]: 'abc' }, []);
    expect(r.errors[key]).toBe('Enter an amount like 100 or 99.50.');
    expect(r.filters[key]).toBeUndefined();
  });

  test('search text over 100 characters gives an error', () => {
    const r = parseFilters({ q: 'x'.repeat(101) }, []);
    expect(r.errors.q).toBe('Search text must be 100 characters or fewer.');
    expect(r.filters.q).toBeUndefined();
  });

  test('search text of exactly 100 characters is accepted', () => {
    const r = parseFilters({ q: 'x'.repeat(100) }, []);
    expect(r.errors.q).toBeUndefined();
    expect(r.filters.q).toHaveLength(100);
  });
});

describe('categories: the edit page and renaming', () => {
  let janeId, samId, food, rent, samCat, agent;

  beforeEach(async () => {
    db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
    janeId = addUser(jane);
    samId = addUser(sam);
    food = addCategory(janeId, 'Food');
    rent = addCategory(janeId, 'Rent');
    samCat = addCategory(samId, 'SamOnly');
    agent = await loginAs(jane);
  });

  test('the edit page opens with the current name', async () => {
    const res = await agent.get(`/categories/${food}/edit`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Food');
  });

  test('the edit page of another user\'s category is not found', async () => {
    const res = await agent.get(`/categories/${samCat}/edit`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('SamOnly');
  });

  test('renaming to an empty name is rejected with a message', async () => {
    const res = await agent.post(`/categories/${food}`).type('form').send({ name: '   ' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please enter a category name.');
    expect(categoryName(food)).toBe('Food');
  });

  test('renaming to a name you already have is rejected', async () => {
    const res = await agent.post(`/categories/${food}`).type('form').send({ name: 'rent' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('You already have a category with this name.');
    expect(categoryName(food)).toBe('Food');
  });

  test('renaming to a name that is too long is rejected', async () => {
    const res = await agent.post(`/categories/${food}`).type('form').send({ name: 'x'.repeat(41) });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Category name must be 40 characters or fewer.');
  });

  test('changing only the capital letters of your own category is allowed', async () => {
    const res = await agent.post(`/categories/${food}`).type('form').send({ name: 'FOOD' });
    expect(res.status).toBe(302);
    expect(categoryName(food)).toBe('FOOD');
  });
});

describe('login and register', () => {
  beforeEach(() => {
    db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
    addUser(jane);
    addUser(admin, 'admin');
  });

  test('empty login fields show a message for each field', async () => {
    const res = await request(app).post('/login').type('form').send({ email: '', password: '' });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Please enter your email.');
    expect(res.text).toContain('Please enter your password.');
  });

  test('a logged-in user who opens the login or register page is sent to their home page', async () => {
    const agent = await loginAs(jane);
    for (const url of ['/login', '/register']) {
      const res = await agent.get(url);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/dashboard');
    }
  });

  test('a logged-in admin is sent to the admin page instead', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/login');
    expect(res.headers.location).toBe('/admin');
  });
});

describe('errors', () => {
  beforeEach(() => {
    db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
    addUser(jane);
  });

  test('a badly encoded address gets a 400 page, not a server error', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/categories/%E0%A4%A/edit');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid request');
  });

  test('a real server error shows the friendly 500 page', async () => {
    const agent = await loginAs(jane);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const broken = jest.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('the database is down');
    });
    try {
      const res = await agent.get('/categories');
      expect(res.status).toBe(500);
      expect(res.text).toContain('Something went wrong');
      expect(res.text).not.toContain('the database is down'); // the error details stay private
    } finally {
      broken.mockRestore();
      quiet.mockRestore();
    }
  });
});