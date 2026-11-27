// Use an in-memory database so tests never touch your real data
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-secret';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../app');
const db = require('../db');
const { parseStatement, parseDate, parseAmount } = require('../utils/csvImport');

const jane = { name: 'Jane Test', email: 'jane@example.com', password: 'Password1' };
const sam = { name: 'Sam Test', email: 'sam@example.com', password: 'Password1' };
const admin = { name: 'Admin Test', email: 'admin@example.com', password: 'Password1' };

const addUser = ({ name, email, password }, role = 'user') =>
  db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), role).lastInsertRowid;
const addCategory = (userId, name) =>
  db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)').run(userId, name).lastInsertRowid;
const transactionsOf = (userId) =>
  db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date, id').all(userId);

async function loginAs({ email, password }) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password });
  return agent;
}

// ---------- reading dates and amounts ----------
describe('parseDate', () => {
  test.each([
    ['2026-11-05', '2026-11-05'],
    ['2026/11/05', '2026-11-05'],
    ['5/11/2026', '2026-11-05'], // day first
    ['05/11/2026', '2026-11-05'],
    ['2026-1-2', '2026-01-02'],
  ])('reads %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  test.each(['2026-02-30', '31/04/2026', '2026-13-01', 'tomorrow', '', '11-05-2026', '1999-12-31'])('rejects "%s"', (input) => {
    expect(parseDate(input)).toBeNull();
  });
});

describe('parseAmount', () => {
  test.each([
    ['-125.50', -125.5],
    ['125.5', 125.5],
    ['+50', 50],
    ['99,50', 99.5],
    ['-99,5', -99.5],
    [' 1 500 ', 1500],
    ['0', 0],
  ])('reads %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  test.each(['1,234.50', '1,234', 'abc', '12.345', '', '--5', 'R100'])('rejects "%s"', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

// ---------- reading a whole statement ----------
describe('parseStatement', () => {
  const cats = [{ id: 1, name: 'Rent' }, { id: 2, name: 'Groceries' }];
  const parse = (csv) => parseStatement(csv, cats, 2);

  test('negative amounts are expenses and positive amounts are income', () => {
    const r = parse('date,amount\n2026-11-01,-100\n2026-11-02,250.50');
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => [x.type, x.amount])).toEqual([['expense', 100], ['income', 250.5]]);
  });

  test('understands header aliases, capitals and a byte order mark', () => {
    const r = parse('\uFEFFTransaction Date, VALUE ,Description\n01/11/2026,-5,Coffee');
    expect(r.problems).toEqual([]);
    expect(r.rows[0]).toMatchObject({ date: '2026-11-01', amount: 5, note: 'Coffee', type: 'expense' });
  });

  test('quoted fields can contain commas', () => {
    const r = parse('date,description,amount\n2026-11-01,"Spar, Vereeniging",-45.20');
    expect(r.rows[0].note).toBe('Spar, Vereeniging');
  });

  test('a type column decides between income and expense', () => {
    const r = parse('date,amount,type\n2026-11-01,100,expense\n2026-11-02,-50,income');
    expect(r.rows.map((x) => [x.type, x.amount])).toEqual([['expense', 100], ['income', 50]]);
  });

  test('a category column matches your categories without caring about capitals', () => {
    const r = parse('date,amount,category\n2026-11-01,-5,RENT\n2026-11-02,-5,Unknown\n2026-11-03,-5,');
    expect(r.rows.map((x) => [x.category_id, x.usedDefault])).toEqual([[1, false], [2, true], [2, true]]);
  });

  test('bad rows are reported with their line number and the good rows are kept', () => {
    const r = parse('date,amount\n2026-11-01,-5\nnot-a-date,-5\n2026-11-03,abc\n2026-11-04,0\n2026-11-05,-9');
    expect(r.rows).toHaveLength(2);
    expect(r.problems.map((p) => p.line)).toEqual([3, 4, 5]);
    expect(r.problems[0].message).toContain('Invalid date');
    expect(r.problems[1].message).toContain('Invalid amount');
    expect(r.problems[2].message).toBe('The amount cannot be 0.');
  });

  test('a thousands separator is reported instead of being guessed', () => {
    const r = parse('date,amount\n2026-11-01,"-1,234.50"');
    expect(r.rows).toHaveLength(0);
    expect(r.problems[0].message).toContain('no thousands separators');
  });

  test('an invalid type is reported', () => {
    const r = parse('date,amount,type\n2026-11-01,5,gift');
    expect(r.problems[0].message).toContain('Invalid type');
  });

  test('long notes are cut to 200 characters', () => {
    const r = parse(`date,amount,note\n2026-11-01,-5,${'x'.repeat(300)}`);
    expect(r.rows[0].note).toHaveLength(200);
  });

  test('an empty note is stored as nothing', () => {
    expect(parse('date,amount,note\n2026-11-01,-5,').rows[0].note).toBeNull();
  });

  test('echoed values in messages are shortened', () => {
    const r = parse(`date,amount\n${'9'.repeat(100)},-5`);
    expect(r.problems[0].message.length).toBeLessThan(120);
  });

  test.each([
    ['a file with only a header', 'date,amount', 'no transactions'],
    ['a file without a date column', 'when,amount\n2026-11-01,5', '"date" column'],
    ['a file without an amount column', 'date,total\n2026-11-01,5', '"amount" column'],
    ['rows with the wrong number of columns', 'date,amount\n2026-11-01,5,extra', 'could not be read'],
    ['an unclosed quote', 'date,amount\n"2026-11-01,5', 'could not be read'],
  ])('%s is refused with a clear message', (name, csv, part) => {
    const r = parse(csv);
    expect(r.fatal).toContain(part);
    expect(r.rows).toBeUndefined();
  });

  test('more than 500 rows is refused', () => {
    const lines = ['date,amount'];
    for (let i = 0; i < 501; i++) lines.push('2026-11-01,-1');
    expect(parse(lines.join('\n')).fatal).toContain('more than 500 rows');
  });

  test('exactly 500 rows is accepted', () => {
    const lines = ['date,amount'];
    for (let i = 0; i < 500; i++) lines.push('2026-11-01,-1');
    expect(parse(lines.join('\n')).rows).toHaveLength(500);
  });

  test('the example file on the site is valid', () => {
    const text = fs.readFileSync(path.join(__dirname, '../public/example-statement.csv'), 'utf8');
    const r = parse(text);
    expect(r.problems).toEqual([]);
    expect(r.rows).toHaveLength(5);
  });
});

// ---------- the pages ----------
describe('uploading, previewing and importing', () => {
  let janeId, samId, rent, groceries, agent;
  const CSV = [
    'date,description,amount,category',
    '2026-11-01,Salary,18000.00,Salary',
    '2026-11-02,Rent,-6500.00,rent',
    '2026-11-05,Woolworths,-845.50,Groceries',
    'oops,Broken row,-1,',
    '2026-11-10,Mystery shop,-20,Nowhere',
  ].join('\n');

  const upload = (who, csv, filename = 'statement.csv', category = groceries) => {
    const req = who.post('/transactions/import').attach('file', Buffer.from(csv), filename);
    return category === null ? req : req.field('category_id', String(category));
  };

  beforeEach(async () => {
    db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
    janeId = addUser(jane);
    samId = addUser(sam);
    addCategory(janeId, 'Salary');
    rent = addCategory(janeId, 'Rent');
    groceries = addCategory(janeId, 'Groceries');
    agent = await loginAs(jane);
  });

  test('the upload page opens', async () => {
    const res = await agent.get('/transactions/import');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Upload a bank statement');
    expect(res.text).toContain('/example-statement.csv');
  });

  test('the example file can be downloaded', async () => {
    const res = await request(app).get('/example-statement.csv');
    expect(res.status).toBe(200);
  });

  test('a preview shows the counts and the bad rows, and saves nothing yet', async () => {
    const res = await upload(agent, CSV);
    expect(res.status).toBe(200);
    expect(res.text).toContain('4 will be imported');
    expect(res.text).toContain('0 already exist');
    expect(res.text).toContain('1 row has a problem');
    expect(res.text).toContain('Line 5: Invalid date');
    expect(res.text).toContain('Import 4 transactions');
    expect(transactionsOf(janeId)).toHaveLength(0);
  });

  test('confirming imports the good rows with the right types, amounts and categories', async () => {
    await upload(agent, CSV);
    const res = await agent.post('/transactions/import/confirm');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/transactions');

    const rows = transactionsOf(janeId);
    expect(rows).toHaveLength(4);
    const by = (note) => rows.find((r) => r.note === note);
    expect(by('Salary')).toMatchObject({ type: 'income', amount: 18000, date: '2026-11-01' });
    expect(by('Rent')).toMatchObject({ type: 'expense', amount: 6500, category_id: rent }); // "rent" matched in lower case
    expect(by('Woolworths')).toMatchObject({ type: 'expense', amount: 845.5, category_id: groceries });
    expect(by('Mystery shop').category_id).toBe(groceries); // unknown category uses the default
  });

  test('the preview can only be imported once', async () => {
    await upload(agent, CSV);
    await agent.post('/transactions/import/confirm');
    const again = await agent.post('/transactions/import/confirm');
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe('/transactions/import');
    expect(transactionsOf(janeId)).toHaveLength(4);
  });

  test('uploading the same statement again skips rows that already exist', async () => {
    await upload(agent, CSV);
    await agent.post('/transactions/import/confirm');
    const res = await upload(agent, CSV);
    expect(res.text).toContain('0 will be imported');
    expect(res.text).toContain('4 already exist');
    expect(res.text).toContain('There is nothing new to import.');
    await agent.post('/transactions/import/confirm');
    expect(transactionsOf(janeId)).toHaveLength(4);
  });

  test('another user\'s transactions do not count as duplicates', async () => {
    const samSalary = addCategory(samId, 'Salary');
    db.prepare("INSERT INTO transactions (user_id, category_id, type, amount, date, note) VALUES (?, ?, 'income', 18000, '2026-11-01', 'Salary')").run(samId, samSalary);
    const res = await upload(agent, CSV);
    expect(res.text).toContain('4 will be imported');
  });

  test('two identical rows inside one file are both imported', async () => {
    await upload(agent, 'date,description,amount\n2026-11-01,Coffee,-30\n2026-11-01,Coffee,-30');
    await agent.post('/transactions/import/confirm');
    expect(transactionsOf(janeId)).toHaveLength(2);
  });

  test('a file with only bad rows has nothing to import', async () => {
    const res = await upload(agent, 'date,amount\nx,y');
    expect(res.text).toContain('0 will be imported');
    expect(res.text).toContain('There is nothing new to import.');
  });

  test('a file that is not a .csv is refused', async () => {
    const res = await upload(agent, CSV, 'statement.txt');
    expect(res.status).toBe(422);
    expect(res.text).toContain('Choose a .csv file to upload.');
  });

  test('no file at all is refused', async () => {
    const res = await agent.post('/transactions/import').field('category_id', String(groceries));
    expect(res.status).toBe(422);
    expect(res.text).toContain('Choose a .csv file to upload.');
  });

  test('a missing default category is refused', async () => {
    const res = await upload(agent, CSV, 'statement.csv', null);
    expect(res.status).toBe(422);
    expect(res.text).toContain('Choose a category for rows that do not name one.');
  });

  test('another user\'s category cannot be the default', async () => {
    const samCat = addCategory(samId, 'SamOnly');
    const res = await upload(agent, CSV, 'statement.csv', samCat);
    expect(res.status).toBe(422);
    expect(transactionsOf(janeId)).toHaveLength(0);
  });

  test('a file over 1 MB is refused', async () => {
    const big = 'date,amount\n' + '2026-11-01,-1\n'.repeat(90000);
    const res = await upload(agent, big);
    expect(res.status).toBe(422);
    expect(res.text).toContain('larger than 1 MB');
  });

  test('a file that is not really CSV shows the readable error', async () => {
    const res = await upload(agent, 'date,amount\n"2026-11-01,5');
    expect(res.status).toBe(422);
    expect(res.text).toContain('could not be read');
  });

  test('a category deleted during the preview stops the import', async () => {
    await upload(agent, 'date,amount\n2026-11-01,-5', 'statement.csv', groceries);
    db.prepare('DELETE FROM categories WHERE id = ?').run(groceries);
    const res = await agent.post('/transactions/import/confirm');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/transactions/import');
    expect(transactionsOf(janeId)).toHaveLength(0);
  });

  test('starting again clears an old preview', async () => {
    await upload(agent, CSV);
    await agent.get('/transactions/import');
    const res = await agent.post('/transactions/import/confirm');
    expect(res.headers.location).toBe('/transactions/import');
    expect(transactionsOf(janeId)).toHaveLength(0);
  });

  test('the word "import" is not mistaken for a transaction id', async () => {
    const res = await agent.get('/transactions/import');
    expect(res.status).toBe(200);
  });
});

describe('access', () => {
  beforeEach(() => {
    db.exec('DELETE FROM budgets; DELETE FROM transactions; DELETE FROM categories; DELETE FROM users;');
    addUser(jane);
    addUser(admin, 'admin');
  });

  test('an admin is blocked (403)', async () => {
    const agent = await loginAs(admin);
    expect((await agent.get('/transactions/import')).status).toBe(403);
    expect((await agent.post('/transactions/import/confirm')).status).toBe(403);
  });

  test('a logged-out visitor is sent to the login page', async () => {
    const res = await request(app).get('/transactions/import');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('a logged-out visitor cannot upload', async () => {
    const res = await request(app).post('/transactions/import').attach('file', Buffer.from('date,amount\n2026-11-01,5'), 'a.csv');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});