const { budgetStatus, budgetPercent, budgetAlerts } = require('../utils/budgetStatus');

describe('budgetStatus', () => {
  test.each([
    [0, 100, 'ok'],
    [50, 100, 'ok'],
    [79.99, 100, 'ok'],
    [80, 100, 'warning'],
    [80.01, 100, 'warning'],
    [99.99, 100, 'warning'],
    [100, 100, 'exceeded'],
    [100.01, 100, 'exceeded'],
    [250, 100, 'exceeded'],
  ])('spent %s of %s is %s', (spent, limit, expected) => {
    expect(budgetStatus(spent, limit)).toBe(expected);
  });

  test.each([[0], [null], [undefined], [-10]])('a limit of %s means there is nothing to warn about', (limit) => {
    expect(budgetStatus(50, limit)).toBe('none');
  });

  test('exactly 80% is a warning even when decimals make it awkward', () => {
    expect(budgetStatus(16.8, 21)).toBe('warning');
    expect(budgetStatus(0.8, 1)).toBe('warning');
    expect(budgetStatus(0.79, 1)).toBe('ok');
  });

  test('amounts that only differ by floating point noise count as equal', () => {
    expect(budgetStatus(0.1 + 0.2, 0.3)).toBe('exceeded');
  });

  test('missing or invalid spending counts as nothing spent', () => {
    expect(budgetStatus(undefined, 100)).toBe('ok');
    expect(budgetStatus('abc', 100)).toBe('ok');
  });
});

describe('budgetPercent', () => {
  test('rounds down to a whole percent', () => {
    expect(budgetPercent(85.5, 100)).toBe(85);
    expect(budgetPercent(99.99, 100)).toBe(99);
    expect(budgetPercent(100, 100)).toBe(100);
    expect(budgetPercent(115.5, 100)).toBe(115);
  });
  test('is exact at 80% even with awkward decimals', () => {
    expect(budgetPercent(16.8, 21)).toBe(80);
  });
  test('is 0 when there is no limit', () => {
    expect(budgetPercent(50, 0)).toBe(0);
  });
});

describe('budgetAlerts', () => {
  const list = [
    { name: 'A', status: 'ok', percent: 10 },
    { name: 'B', status: 'warning', percent: 85 },
    { name: 'C', status: 'exceeded', percent: 120 },
    { name: 'D', status: 'warning', percent: 95 },
    { name: 'E', status: 'exceeded', percent: 150 },
    { name: 'F', status: 'none', percent: 0 },
  ];
  test('keeps only warnings and exceeded budgets, worst first', () => {
    expect(budgetAlerts(list).map((b) => b.name)).toEqual(['E', 'C', 'D', 'B']);
  });
  test('returns an empty list when everything is fine', () => {
    expect(budgetAlerts([{ name: 'A', status: 'ok', percent: 10 }])).toEqual([]);
  });
});