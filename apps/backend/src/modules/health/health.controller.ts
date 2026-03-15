import type { FastifyInstance } from 'fastify'
import { HealthService } from './health.service.js'

const service = new HealthService()

export async function healthController(app: FastifyInstance) {
  app.get('/', async () => {
    return service.hello()
  })
}
