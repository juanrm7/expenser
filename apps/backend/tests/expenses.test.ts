// Expense and weekly/monthly summary regression tests.

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { addDays, formatDate, parseDate, startOfDay, weekStart } from '../src/lib/dates.js'
import { iso, local, NOW, pluck, TestApp } from './helpers.js'

async function setup(t: TestContext) {
  const app = await TestApp.spawn(t)
  await app.seedUsers()
  return app
}

test('weeks start on Saturday across month, year and leap-day boundaries', () => {
  for (const [day, expected] of [
    ['2026-10-17', '2026-10-17'],
    ['2026-10-18', '2026-10-17'],
    ['2026-10-23', '2026-10-17'],
    ['2026-01-01', '2025-12-27'],
    ['2024-03-01', '2024-02-24'],
  ] as const) {
    assert.equal(formatDate(weekStart(local(`${day}T12:00:00`))), expected, `week of ${day}`)
  }
})

test('only valid strict dates parse, to the start of their local day', () => {
  for (const invalid of ['2026-02-30', '2026-2-03', '+2026-0203', '2026-10-12T00:00', '']) {
    assert.equal(parseDate(invalid), null, invalid)
  }
  assert.equal(formatDate(parseDate('2024-02-29')!), '2024-02-29')
  const start = parseDate('2026-10-12')!
  assert.equal(start.getTime(), startOfDay(local('2026-10-12T15:30:00')).getTime())
  assert.equal(formatDate(new Date(start.getTime() - 1)), '2026-10-11')
  assert.equal(formatDate(addDays(start, 20)), '2026-11-01')
})

test('a past week includes Saturday through Friday only, and only the user’s expenses', async (t) => {
  const app = await setup(t)
  await app.seedExpense('2026-10-09T23:59:59.999', 5, 1)
  const first = await app.seedExpense('2026-10-10T00:00:00', 100, 1)
  const last = await app.seedExpense('2026-10-16T23:59:59.999', 200, 1)
  await app.seedExpense('2026-10-17T00:00:00', 400, 1)
  await app.seedExpense('2026-10-12T12:00:00', 900, 2)

  const response = await app.get('/expenses/summary?weekStart=2026-10-10')
  assert.equal(response.status, 200)
  const summary = response.body
  assert.equal(summary.weekStart, '2026-10-10')
  assert.equal(summary.currentWeekStart, '2026-10-17')
  assert.equal(summary.today, '2026-10-22')
  assert.deepEqual(pluck(summary.expenses, 'id'), [last, first])
  assert.deepEqual(pluck(summary.expenses, 'date'), ['2026-10-16', '2026-10-10'])
  assert.equal(summary.spent, 300)
  assert.equal(summary.available, 700)
  assert.equal(summary.monthly.spent, 705)
})

test('the default summary shows the current week, and empty weeks have zero spent', async (t) => {
  const app = await setup(t)
  await app.seedExpense('2026-10-16T12:00:00', 100, 1)
  await app.seedExpense('2026-10-17T12:00:00', 200, 1)

  const current = (await app.get('/expenses/summary')).body
  assert.equal(current.weekStart, '2026-10-17')
  assert.equal(current.spent, 200)
  assert.equal(current.monthly.monthStart, '2026-10-01')
  assert.equal(current.monthly.allowance, (1000 / 7) * 31)

  const empty = (await app.get('/expenses/summary?weekStart=2026-01-03')).body
  assert.deepEqual(empty.expenses, [])
  assert.equal(empty.spent, 0)
  assert.equal(empty.available, 1000)
})

test('invalid, non-Saturday and future weeks are rejected', async (t) => {
  const app = await setup(t)
  for (const value of ['invalid', '', '2026-02-30', '2026-10-11', '2026-10-24']) {
    const response = await app.get(`/expenses/summary?weekStart=${value}`)
    assert.equal(response.status, 400, `weekStart=${value}`)
  }
})

test('a missed expense can be created, edited and deleted while browsing a past week', async (t) => {
  const app = await setup(t)
  const created = await app.post('/expenses', {
    amount: 100,
    description: 'Missed lunch',
    categoryId: 1,
    date: '2026-10-12',
  })
  assert.equal(created.status, 201)
  const expense = created.body
  assert.equal(expense.createdAt, iso(local('2026-10-12T00:00:00')))
  assert.equal(expense.category, 'Food')
  assert.equal(expense.userId, 1)

  const edited = await app.patch(`/expenses/${expense.id}`, {
    amount: 150,
    description: 'Corrected lunch',
    categoryId: 2,
  })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.category, 'Transport')
  assert.equal(edited.body.createdAt, expense.createdAt)

  const summary = (await app.get('/expenses/summary?weekStart=2026-10-10')).body
  assert.equal(summary.spent, 150)
  assert.equal(summary.monthly.spent, 150)
  assert.equal(summary.expenses[0].description, 'Corrected lunch')
  assert.equal((await app.get('/expenses/summary')).body.spent, 0)

  assert.equal((await app.delete(`/expenses/${expense.id}`)).status, 204)
  assert.equal((await app.get('/expenses/summary?weekStart=2026-10-10')).body.spent, 0)
  assert.equal((await app.get(`/expenses/${expense.id}`)).status, 404)
})

test('editing keeps a deleted category, and changing the date moves the expense between weeks', async (t) => {
  const app = await setup(t)
  await app.execute(
    `INSERT INTO Expense (id, description, amount, category, createdAt, updatedAt, userId)
     VALUES (1000, 'Old expense', 100, 'Deleted category', ?1, ?1, 1)`,
    [local('2026-09-30T12:00:00')],
  )

  const response = await app.patch('/expenses/1000', { amount: 125, date: '2026-10-12' })
  assert.equal(response.status, 200)
  assert.equal(response.body.category, 'Deleted category')
  assert.equal((await app.get('/expenses/summary?weekStart=2026-09-26')).body.spent, 0)
  const summary = (await app.get('/expenses/summary?weekStart=2026-10-10')).body
  assert.equal(summary.spent, 125)
  assert.equal(summary.monthly.spent, 125)
})

test('creating without a date records the expense now', async (t) => {
  const app = await setup(t)
  const response = await app.post('/expenses', { amount: 10, description: '', categoryId: 1 })
  assert.equal(response.status, 201)
  assert.equal(response.body.createdAt, iso(NOW))
  assert.equal(response.body.updatedAt, iso(NOW))
})

test('invalid dates and non-positive amounts cannot be created or saved', async (t) => {
  const app = await setup(t)
  const id = await app.seedExpense('2026-10-12T12:00:00', 100, 1)
  for (const change of [
    { date: '2026-02-30' },
    { date: '2026-10-23' },
    { date: 'invalid' },
    { amount: 0 },
    { amount: -10 },
  ]) {
    const created = await app.post('/expenses', { amount: 10, description: '', categoryId: 1, ...change })
    assert.equal(created.status, 400, `create with ${JSON.stringify(change)}`)
    const updated = await app.patch(`/expenses/${id}`, change)
    assert.equal(updated.status, 400, `update with ${JSON.stringify(change)}`)
  }
  assert.equal((await app.patch(`/expenses/${id}`, {})).body.message, 'Nothing to update')
  const missingField = await app.post('/expenses', { amount: 10, categoryId: 1 })
  assert.equal(missingField.status, 400)
  assert.match(missingField.body.message, /description/)
})

test('expenses and category ids of another user cannot be used', async (t) => {
  const app = await setup(t)
  const id = await app.seedExpense('2026-10-12T12:00:00', 100, 2)
  assert.equal((await app.get(`/expenses/${id}`)).status, 404)
  assert.equal((await app.patch(`/expenses/${id}`, { amount: 1 })).status, 404)
  assert.equal((await app.delete(`/expenses/${id}`)).status, 404)
  const foreignCategory = await app.post('/expenses', { amount: 1, description: '', categoryId: 3, date: '2026-10-12' })
  assert.equal(foreignCategory.status, 404)
  assert.equal(foreignCategory.body.message, 'Category not found')
  assert.deepEqual((await app.get('/expenses')).body, [])

  const anonymous = await app.request('GET', '/expenses/summary?weekStart=2026-10-10')
  assert.equal(anonymous.status, 401)
  assert.deepEqual(anonymous.body, { message: 'Unauthorized' })
})

test('expenses are listed newest first', async (t) => {
  const app = await setup(t)
  const older = await app.seedExpense('2026-10-01T09:00:00', 1, 1)
  const newer = await app.seedExpense('2026-10-20T09:00:00', 2, 1)
  assert.deepEqual(pluck((await app.get('/expenses')).body, 'id'), [newer, older])
})
