import type { z } from 'zod'

/**
 * An expected failure, explained to the client: the error handler answers it with `status` and
 * `{ "message": "…" }`, and MCP tools return it as a tool error the model can act on. Anything
 * else thrown is unexpected: logged, and answered with a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }

  static badRequest(message: string) {
    return new AppError(400, message)
  }

  static notFound(message: string) {
    return new AppError(404, message)
  }

  static unauthorized() {
    return new AppError(401, 'Unauthorized')
  }
}

/** Validates a request body, query or tool input; a 400 naming the first problem otherwise. */
export function parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const [issue] = result.error.issues
  const path = issue?.path.join('.')
  throw AppError.badRequest(path ? `${path}: ${issue?.message}` : (issue?.message ?? 'Invalid request'))
}

/** The numeric id of a route like `/expenses/:id`. */
export function parseId(value: string): number {
  const id = Number(value)
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(id)) throw AppError.badRequest('Invalid id')
  return id
}

/** Turns an explicit `null` (as an optional JSON field) into `undefined`: both mean "not given". */
export function given<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}
