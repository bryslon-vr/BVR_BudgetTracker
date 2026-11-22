// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { currentMonth, shiftMonth, shortMonth } = require('../utils/months');
const { adminStats } = require('../utils/adminStats');

const admin = { name: 'Admin Test', email: 'admin@example.com', password: 'Password1' };
const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };
const lee = { name: 'Lee Test', email: 'lee@example.com', password: 'Password1' };

const addUser = ({ name, email, password }, role = 'user', createdAt = null) =>
  db.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))")
    .run(name, email, bcrypt.hashSync(password, 10), role, createdAt).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const addTx = (userId, categoryId, amount, date, note = null) =>
  db.prepare("INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, 'expense', ?, ?, ?)")
    .run(userId, categoryId, amount, date, note);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

const month = currentMonth();
const day = `${month}-01`;
const lastMonth = shiftMonth(month, -1);
const stat = (label, value) => new RegExp(`${label}</div><div class="stat-value">${value}</div>`);
const adminJson = (html) => JSON.parse(html.match(/<script id="admin-data" type="application\/json">(.*?)<\/script>/s)[1]);

let adminId, janeId, samId, leeId, janeGroceries, samGroceries, leeRent;

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  adminId = addUser(admin, 'admin');
  janeId = addUser(jane);
  samId = addUser(sam);
  leeId = addUser(lee, 'user', '2020-01-15 10:00:00'); // signed up long ago
  janeGroceries = addCategory(janeId, 'Groceries');
  samGroceries = addCategory(samId, 'groceries'); // same name, different capitals
  leeRent = addCategory(leeId, 'Rent');
});

describe('adminStats', () => {
  test('counts users but not admins, and new users only this month', () => {
    const s = adminStats(month);
    expect(s.totalUsers).toBe(3);
    expect(s.newUsers).toBe(2); // Jane and Sam, created now
  });

  test('counts active users and transactions', () => {
    addTx(janeId, janeGroceries, 10, day);
    addTx(janeId, janeGroceries, 20, day);
    addTx(samId, samGroceries, 30, `${lastMonth}-15`);
    const s = adminStats(month);
    expect(s.totalTransactions).toBe(3);
    expect(s.activeUsers).toBe(1); // only Jane has a transaction this month
  });

  test('gives six months of counts, with zeros for empty months', () => {
    addTx(janeId, janeGroceries, 10, day);
    addTx(samId, samGroceries, 10, day);
    addTx(samId, samGroceries, 10, `${lastMonth}-02`);
    const s = adminStats(month);
    expect(s.perMonth).toHaveLength(6);
    expect(s.perMonth[5]).toEqual({ month, label: shortMonth(month), count: 2 });
    expect(s.perMonth[4].count).toBe(1);
    expect(s.perMonth.slice(0, 4).every((m) => m.count === 0)).toBe(true);
  });

  test('only names used by at least 2 users appear in the top categories', () => {
    addTx(janeId, janeGroceries, 10, day);
    addTx(samId, samGroceries, 10, day);
    addTx(samId, samGroceries, 10, day);
    addTx(leeId, leeRent, 10, day); // Rent is only used by one user
    const s = adminStats(month);
    expect(s.topCategories).toHaveLength(1);
    expect(s.topCategories[0]).toMatchObject({ uses: 3, users: 2 });
    expect(s.topCategories[0].name.toLowerCase()).toBe('groceries');
  });

  test('is all zeros with no data', () => {
    db.exec('DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
    const s = adminStats(month);
    expect(s).toMatchObject({ totalUsers: 0, newUsers: 0, activeUsers: 0, totalTransactions: 0, topCategories: [] });
  });
});

describe('the admin page', () => {
  test('shows the totals', async () => {
    addTx(janeId, janeGroceries, 10, day);
    addTx(samId, samGroceries, 10, day);
    const agent = await loginAs(admin);
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(stat('Total users', 3));
    expect(res.text).toMatch(stat('New users this month', 2));
    expect(res.text).toMatch(stat('Active users this month', 2));
    expect(res.text).toMatch(stat('Total transactions', 2));
  });

  test('passes the six monthly counts to the chart', async () => {
    addTx(janeId, janeGroceries, 10, day);
    addTx(samId, samGroceries, 10, day);
    const agent = await loginAs(admin);
    const data = adminJson((await agent.get('/admin')).text);
    expect(data.labels).toHaveLength(6);
    expect(data.counts[5]).toBe(2);
    expect(data.counts.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  test('lists categories used by at least 2 users and hides the rest', async () => {
    addTx(janeId, janeGroceries, 10, day);
    addTx(samId, samGroceries, 10, day);
    addTx(leeId, leeRent, 10, day);
    const secret = addCategory(janeId, 'Private therapy');
    addTx(janeId, secret, 10, day);
    const agent = await loginAs(admin);
    const res = await agent.get('/admin');
    expect(res.text).toMatch(/2 transactions &middot; 2 users/);
    expect(res.text).not.toContain('Rent');
    expect(res.text).not.toContain('Private therapy');
  });

  test('says so when no category is shared', async () => {
    const agent = await loginAs(admin);
    const res = await agent.get('/admin');
    expect(res.text).toContain('No category is used by at least 2 users yet.');
  });

  test('never shows names, emails, notes or amounts of individual users', async () => {
    addTx(janeId, janeGroceries, 1234.56, day, 'SecretNote about my salary');
    addTx(samId, samGroceries, 99.99, day, 'AnotherPrivateNote');
    const agent = await loginAs(admin);
    const res = await agent.get('/admin');
    for (const hidden of ['Jane Test', 'Sam Test', 'Lee Test', 'jane@example.com', 'sam@example.com', 'SecretNote', 'AnotherPrivateNote', '1,234.56', '1234.56', '99.99']) {
      expect(res.text).not.toContain(hidden);
    }
    expect(res.text).toContain('Individual transactions, amounts and notes are never visible to the admin.');
  });
});

describe('access', () => {
  test('a normal user gets 403 on the admin page', async () => {
    const agent = await loginAs(jane);
    expect((await agent.get('/admin')).status).toBe(403);
  });

  test('a logged-out visitor is sent to the login page', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('the admin cannot reach any page that shows personal budget data', async () => {
    const agent = await loginAs(admin);
    for (const url of ['/dashboard', '/transactions', '/budgets']) {
      expect((await agent.get(url)).status).toBe(403);
    }
    expect((await agent.post('/transactions').type('form').send({})).status).toBe(403);
  });
});