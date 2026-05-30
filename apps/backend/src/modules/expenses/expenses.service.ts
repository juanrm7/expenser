import prisma from '../../lib/prisma.js'
import type { CreateExpenseBody, UpdateExpenseBody } from './expenses.types.js'
import type { SessionUser } from '../auth/auth.types.js'

function getCurrentWeekStart(): Date {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 6 ? 0 : -(day + 1) // roll back to most recent Saturday
  const saturday = new Date(now)
  saturday.setDate(now.getDate() + diff)
  saturday.setHours(0, 0, 0, 0)
  return saturday
}

export class ExpensesService {
  getAll(userId: number) {
    return prisma.expense.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async getWeeklySummary(user: SessionUser) {
    const weekStart = getCurrentWeekStart()
    const expenses = await prisma.expense.findMany({
      where: { userId: user.id, createdAt: { gte: weekStart } },
      orderBy: { createdAt: 'desc' },
    })
    const spent = expenses.reduce((sum, e) => sum + e.amount, 0)
    const allowance = user.expendableAmountPerWeek
    return {
      weekStart: weekStart.toISOString().split('T')[0],
      allowance,
      spent,
      available: allowance - spent,
      expenses,
    }
  }

  getById(userId: number, id: number) {
    return prisma.expense.findFirst({ where: { id, userId } })
  }

  create(userId: number, data: CreateExpenseBody) {
    return prisma.expense.create({ data: { ...data, userId } })
  }

  async update(userId: number, id: number, data: UpdateExpenseBody) {
    const result = await prisma.expense.updateMany({ where: { id, userId }, data })
    if (result.count === 0) return null
    return prisma.expense.findUnique({ where: { id } })
  }

  async delete(userId: number, id: number) {
    const result = await prisma.expense.deleteMany({ where: { id, userId } })
    return result.count > 0
  }
}
