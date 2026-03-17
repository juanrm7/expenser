import type { FastifyInstance } from 'fastify'
import { ExpensesService } from './expenses.service.js'
import { CategoriesService } from '../categories/categories.service.js'
import type { CreateExpenseRequest, UpdateExpenseRequest } from './expenses.types.js'
import { isNotFound } from '../../lib/prisma-errors.js'

const service = new ExpensesService()
const categoriesService = new CategoriesService()

export async function expensesController(app: FastifyInstance) {
  app.get('/expenses', async () => {
    return service.getAll()
  })

  app.get<{ Params: { id: string } }>('/expenses/:id', async (req, reply) => {
    const expense = await service.getById(Number(req.params.id))

    if (!expense) return reply.status(404).send({ message: 'Expense not found' })
    
    return expense
  })

  app.post<{ Body: CreateExpenseRequest }>('/expenses', async (req, reply) => {
    const { categoryId, ...rest } = req.body

    const category = await categoriesService.getById(categoryId)

    if (!category) return reply.status(404).send({ message: 'Category not found' })

    const expense = await service.create({ ...rest, category: category.name })

    return reply.status(201).send(expense)
  })

  app.patch<{ Params: { id: string }; Body: UpdateExpenseRequest }>(
    '/expenses/:id',
    async (req, reply) => {
      try {
        const { categoryId, ...rest } = req.body
        let data: Record<string, unknown> = rest

        if (categoryId !== undefined) {
          const category = await categoriesService.getById(categoryId)
          if (!category) return reply.status(404).send({ message: 'Category not found' })
          data = { ...rest, category: category.name }
        }

        return await service.update(Number(req.params.id), data)
      } catch (err) {
        if (isNotFound(err)) return reply.status(404).send({ message: 'Expense not found' })
        req.log.error(err)
        return reply.status(500).send({ message: 'Internal server error' })
      }
    }
  )

  app.delete<{ Params: { id: string } }>('/expenses/:id', async (req, reply) => {
    try {
      await service.delete(Number(req.params.id))
      return reply.status(204).send()
    } catch (err) {
      if (isNotFound(err)) return reply.status(404).send({ message: 'Expense not found' })
      req.log.error(err)
      return reply.status(500).send({ message: 'Internal server error' })
    }
  })
}
