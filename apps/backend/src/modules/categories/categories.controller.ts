import type { FastifyInstance } from 'fastify'
import { CategoriesService } from './categories.service.js'
import type { CreateCategoryBody, UpdateCategoryBody } from './categories.types.js'

const service = new CategoriesService()

export async function categoriesController(app: FastifyInstance) {
  app.get('/categories', async () => {
    return service.getAll()
  })

  app.get<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    const category = await service.getById(Number(req.params.id))
    if (!category) return reply.status(404).send({ message: 'Category not found' })
    return category
  })

  app.post<{ Body: CreateCategoryBody }>('/categories', async (req, reply) => {
    const category = await service.create(req.body)
    return reply.status(201).send(category)
  })

  app.patch<{ Params: { id: string }; Body: UpdateCategoryBody }>(
    '/categories/:id',
    async (req, reply) => {
      try {
        return await service.update(Number(req.params.id), req.body)
      } catch {
        return reply.status(404).send({ message: 'Category not found' })
      }
    }
  )

  app.delete<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    try {
      await service.delete(Number(req.params.id))
      return reply.status(204).send()
    } catch {
      return reply.status(404).send({ message: 'Category not found' })
    }
  })
}
