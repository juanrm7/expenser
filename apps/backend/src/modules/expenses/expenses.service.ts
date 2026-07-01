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

function getCurrentMonthRange(): { start: Date; end: Date; days: number } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0) // first day of next month
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() // last day-of-month number
  return { start, end, days }
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
    const month = getCurrentMonthRange()

    const [expenses, monthlyAgg] = await Promise.all([
      prisma.expense.findMany({
        where: { userId: user.id, createdAt: { gte: weekStart } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.expense.aggregate({
        where: { userId: user.id, createdAt: { gte: month.start, lt: month.end } },
        _sum: { amount: true },
      }),
    ])

    const spent = expenses.reduce((sum, e) => sum + e.amount, 0)
    const allowance = user.expendableAmountPerWeek

    const monthlySpent = monthlyAgg._sum.amount ?? 0
    const monthlyAllowance = (allowance / 7) * month.days

    return {
      weekStart: weekStart.toISOString().split('T')[0],
      allowance,
      spent,
      available: allowance - spent,
      expenses,
      monthly: {
        monthStart: month.start.toISOString().split('T')[0],
        allowance: monthlyAllowance,
        spent: monthlySpent,
        available: monthlyAllowance - monthlySpent,
      },
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
