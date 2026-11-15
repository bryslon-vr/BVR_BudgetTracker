// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { parseFilters, buildWhere } = require('../utils/transactionFilters');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };

const addUser = ({ name, email, password }) =>
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(name, email, bcrypt.hashSync(password, 10)).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const addTx = (userId, categoryId, type, amount, date, note) =>
  db.prepare('INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, categoryId, type, amount, date, note);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

// the filter functions on their own
describe('parseFilters', () => {
  const cats = [1, 2];

  test('accepts valid values and turns amounts into numbers', () => {
    const r = parseFilters({ from: '2026-10-01', to: '2026-10-31', category: '2', type: 'expense', min: '10,50', max: '99', q: 'rent' }, cats);
    expect(r.errors).toEqual({});
    expect(r.filters).toEqual({ from: '2026-10-01', to: '2026-10-31', category: 2, type: 'expense', min: 10.5, max: 99, q: 'rent' });
  });

  test('an invalid date gives an error and is not applied', () => {
    const r = parseFilters({ from: '2026-02-30' }, cats);
    expect(r.errors.from).toBe('Enter a valid date.');
    expect(r.filters.from).toBeUndefined();
  });

  test('a From date after the To date gives an error and ignores both', () => {
    const r = parseFilters({ from: '2026-11-10', to: '2026-11-01' }, cats);
    expect(r.errors.to).toContain('must not be before');
    expect(r.filters.from).toBeUndefined();
    expect(r.filters.to).toBeUndefined();
  });

  test('a minimum above the maximum gives an error', () => {
    const r = parseFilters({ min: '500', max: '100' }, cats);
    expect(r.errors.max).toContain('must not be less');
    expect(r.filters.min).toBeUndefined();
  });

  test('a category that is not the user\'s is rejected', () => {
    const r = parseFilters({ category: '99' }, cats);
    expect(r.errors.category).toBe('Choose one of your categories.');
    expect(r.filters.category).toBeUndefined();
  });

  test('repeated values (arrays) are ignored', () => {
    const r = parseFilters({ from: ['2026-10-01', '2026-10-02'] }, cats);
    expect(r.filters.from).toBeUndefined();
    expect(r.errors).toEqual({});
  });

  test('page numbers fall back to 1 when invalid', () => {
    expect(parseFilters({ page: '0' }, cats).page).toBe(1);
    expect(parseFilters({ page: 'abc' }, cats).page).toBe(1);
    expect(parseFilters({ page: '3' }, cats).page).toBe(3);
  });
});

describe('buildWhere', () => {
  test('always limits the query to the user and only uses placeholders', () => {
    const { where, params } = buildWhere({ q: "x' OR 1=1 --" }, 7);
    expect(where.startsWith('t.user_id = ?')).toBe(true);
    expect(where).not.toContain('OR 1=1');
    expect(params[0]).toBe(7);
  });

  test('makes % and _ in the search text match themselves', () => {
    const { params } = buildWhere({ q: '50%_off' }, 1);
    expect(params[1]).toBe('%50\\%\\_off%');
  });
});

// the page
let janeId, samId, rent, food, samCat;

beforeEach(() => {
  db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
  janeId = addUser(jane);
  samId = addUser(sam);
  rent = addCategory(janeId, 'Rent');
  food = addCategory(janeId, 'Food');
  samCat = addCategory(samId, 'SamCat');
  addTx(janeId, rent, 'expense', 6500, '2026-10-02', 'October rent');
  addTx(janeId, food, 'expense', 120.5, '2026-10-15', 'Groceries at Spar');
  addTx(janeId, food, 'expense', 45, '2026-11-03', 'Lunch with friends');
  addTx(janeId, rent, 'income', 18000, '2026-11-01', 'November salary');
  addTx(janeId, food, 'expense', 80, '2026-11-05', '50% off dinner');
  addTx(samId, samCat, 'expense', 77, '2026-11-02', 'SamSecret');
});

describe('filtering the list', () => {
  test('filters by date range, including the first and last day', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?from=2026-11-01&to=2026-11-03');
    expect(res.text).toContain('November salary');
    expect(res.text).toContain('Lunch with friends');
    expect(res.text).not.toContain('October rent');
    expect(res.text).not.toContain('50% off dinner');
  });

  test('filters by category', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get(`/transactions?category=${rent}`);
    expect(res.text).toContain('October rent');
    expect(res.text).not.toContain('Lunch with friends');
  });

  test('filters by amount range', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?min=100&max=7000');
    expect(res.text).toContain('October rent');
    expect(res.text).toContain('Groceries at Spar');
    expect(res.text).not.toContain('Lunch with friends');
    expect(res.text).not.toContain('November salary');
  });

  test('filters by type', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?type=income');
    expect(res.text).toContain('November salary');
    expect(res.text).not.toContain('October rent');
  });

  test('searches notes without caring about capital letters', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?q=GROCERIES');
    expect(res.text).toContain('Groceries at Spar');
    expect(res.text).not.toContain('October rent');
  });

  test('a % in the search only matches a real %', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?q=%25');
    expect(res.text).toContain('50% off dinner');
    expect(res.text).not.toContain('October rent');
  });

  test('combined filters narrow the results', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get(`/transactions?category=${food}&from=2026-11-01&max=60`);
    expect(res.text).toContain('Lunch with friends');
    expect(res.text).not.toContain('Groceries at Spar');
    expect(res.text).not.toContain('50% off dinner');
  });

  test('shows a message and a reset link when nothing matches', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?q=nothing-like-this');
    expect(res.text).toContain('No transactions match your filters.');
    expect(res.text).toContain('Reset the filters');
  });

  test('shows the totals for the filtered results', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?type=expense&category=' + food);
    expect(res.text).toContain('Expenses -R 245.50');
  });

  test('keeps the typed filter values in the form', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?from=2026-10-05&q=rent');
    expect(res.text).toContain('value="2026-10-05"');
    expect(res.text).toContain('value="rent"');
  });

  test('an invalid date shows a message instead of crashing', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?from=not-a-date');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Enter a valid date.');
  });

  test('never shows another user\'s transactions, even with their category id', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get(`/transactions?category=${samCat}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('SamSecret');
    expect(res.text).toContain('Choose one of your categories.');
  });

  test('a SQL injection attempt is treated as plain text', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?q=' + encodeURIComponent("' OR 1=1 --"));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('SamSecret');
    expect(res.text).not.toContain('October rent');
    expect(res.text).toContain('No transactions match your filters.');
  });
});

describe('paging', () => {
  beforeEach(() => {
    db.exec('DELETE FROM transactions');
    for (let i = 1; i <= 25; i++) {
      const n = String(i).padStart(2, '0');
      addTx(janeId, food, 'expense', 10, `2026-10-${n}`, `Item${n}`);
    }
  });

  test('page 1 has the 20 newest and page 2 has the rest', async () => {
    const agent = await loginAs(jane);
    const p1 = await agent.get('/transactions');
    expect(p1.text).toContain('Item25');
    expect(p1.text).toContain('Item06');
    expect(p1.text).not.toContain('Item05');
    expect(p1.text).toContain('Showing 1–20 of 25');

    const p2 = await agent.get('/transactions?page=2');
    expect(p2.text).toContain('Item05');
    expect(p2.text).toContain('Item01');
    expect(p2.text).not.toContain('Item06');
    expect(p2.text).toContain('Showing 21–25 of 25');
  });

  test('the paging links keep the filters', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get(`/transactions?category=${food}`);
    expect(res.text).toContain(`category=${food}&amp;page=2`);
  });

  test('a page number that is too high shows the last page', async () => {
    const agent = await loginAs(jane);
    const res = await agent.get('/transactions?page=99');
    expect(res.text).toContain('Item01');
    expect(res.text).toContain('Showing 21–25 of 25');
  });
});