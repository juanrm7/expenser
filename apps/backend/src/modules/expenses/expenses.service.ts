import prisma from '../../lib/prisma.js'
import type { CreateExpenseBody, UpdateExpenseBody } from './expenses.types.js'

const BASE_ALLOWANCE = 100_000

function getCurrentWeekStart(): Date {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(now)
  monday.setDate(now.getDate() + diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

export class ExpensesService {
  getAll() {
    return prisma.expense.findMany({ orderBy: { createdAt: 'desc' } })
  }

  async getWeeklySummary() {
    const weekStart = getCurrentWeekStart()
    const expenses = await prisma.expense.findMany({
      where: { createdAt: { gte: weekStart } },
      orderBy: { createdAt: 'desc' },
    })
    const spent = expenses.reduce((sum, e) => sum + e.amount, 0)
    return {
      weekStart: weekStart.toISOString().split('T')[0],
      allowance: BASE_ALLOWANCE,
      spent,
      available: BASE_ALLOWANCE - spent,
      expenses,
    }
  }

  getById(id: number) {
    return prisma.expense.findUnique({ where: { id } })
  }

  create(data: CreateExpenseBody) {
    return prisma.expense.create({ data })
  }

  update(id: number, data: UpdateExpenseBody) {
    return prisma.expense.update({ where: { id }, data })
  }

  delete(id: number) {
    return prisma.expense.delete({ where: { id } })
  }
}
