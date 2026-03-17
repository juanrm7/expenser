import Fastify from 'fastify'
import { healthController } from './modules/health/health.controller.js'
import { categoriesController } from './modules/categories/categories.controller.js'
import { expensesController } from './modules/expenses/expenses.controller.js'

export function buildApp() {
  const app = Fastify({ logger: true })

  app.register(healthController)
  app.register(categoriesController)
  app.register(expensesController)

  return app
}
