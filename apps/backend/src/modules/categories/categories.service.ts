import prisma from '../../lib/prisma.js'
import type { CreateCategoryBody, UpdateCategoryBody } from './categories.types.js'

export class CategoriesService {
  getAll() {
    return prisma.category.findMany()
  }

  getById(id: number) {
    return prisma.category.findUnique({ where: { id } })
  }

  create(data: CreateCategoryBody) {
    return prisma.category.create({ data })
  }

  update(id: number, data: UpdateCategoryBody) {
    return prisma.category.update({ where: { id }, data })
  }

  delete(id: number) {
    return prisma.category.delete({ where: { id } })
  }
}
