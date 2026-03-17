import prisma from '../../lib/prisma.js'
import type { CreateExpenseBody, UpdateExpenseBody } from './expenses.types.js'

export class ExpensesService {
  getAll() {
    return prisma.expense.findMany({ orderBy: { createdAt: 'desc' } })
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
