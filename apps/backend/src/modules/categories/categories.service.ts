import prisma from '../../lib/prisma.js'
import type { CreateCategoryBody, UpdateCategoryBody } from './categories.types.js'

export class CategoriesService {
  getAll(userId: number) {
    return prisma.category.findMany({ where: { userId } })
  }

  getById(userId: number, id: number) {
    return prisma.category.findFirst({ where: { id, userId } })
  }

  create(userId: number, data: CreateCategoryBody) {
    return prisma.category.create({ data: { ...data, userId } })
  }

  async update(userId: number, id: number, data: UpdateCategoryBody) {
    const result = await prisma.category.updateMany({ where: { id, userId }, data })
    if (result.count === 0) return null
    return prisma.category.findUnique({ where: { id } })
  }

  async delete(userId: number, id: number) {
    const result = await prisma.category.deleteMany({ where: { id, userId } })
    return result.count > 0
  }
}
