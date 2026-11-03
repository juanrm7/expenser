// Authentication for routes. Nothing is rejected globally: a handler opts in by calling
// `requireUser` (session cookie or API key, 401 otherwise) or `requireSessionUser` (session only,
// 403 for API keys), and gets the user back.
//
// Browsers authenticate with the httpOnly `session_id` cookie; scripts with an API key in an
// `Authorization: Bearer exp_…` header. A valid session takes precedence.

import type { FastifyRequest } from 'fastify'
import type { Context } from '../context.js'
import { apiKeyUser } from '../modules/api-keys/api-keys.service.js'
import { SESSION_COOKIE, sessionUser, type User } from '../modules/auth/auth.service.js'
import { AppError } from './errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set once a handler authenticated the request; for logs. */
    user: User | null
  }
}

type Authentication = { user: User; method: 'session' | 'apiKey' } | null

/** Each request is authenticated at most once, however many times it's asked for. */
const authentications = new WeakMap<FastifyRequest, Promise<Authentication>>()

function authenticate(ctx: Context, req: FastifyRequest): Promise<Authentication> {
  let authentication = authentications.get(req)
  if (!authentication) {
    authentication = (async (): Promise<Authentication> => {
      const sessionId = req.cookies[SESSION_COOKIE]
      if (sessionId) {
        const user = await sessionUser(ctx, sessionId)
        if (user) return { user, method: 'session' }
      }
      const user = await bearerApiKeyUser(ctx, req)
      return user ? { user, method: 'apiKey' } : null
    })()
    authentications.set(req, authentication)
  }
  return authentication
}

/** The user authenticated by session cookie or API key; 401 if neither is valid. */
export async function requireUser(ctx: Context, req: FastifyRequest): Promise<User> {
  return (await authenticated(ctx, req)).user
}

/** Like `requireUser`, but 403s API keys: for actions only a logged-in browser may take. */
export async function requireSessionUser(ctx: Context, req: FastifyRequest): Promise<User> {
  const { user, method } = await authenticated(ctx, req)
  if (method !== 'session') throw new AppError(403, 'This action requires logging in, not an API key')
  return user
}

async function authenticated(ctx: Context, req: FastifyRequest) {
  const authentication = await authenticate(ctx, req)
  if (!authentication) throw AppError.unauthorized()
  req.user = authentication.user
  return authentication
}

/** The owner of the `Authorization: Bearer <api key>` header's key, ignoring any session cookie. */
export async function bearerApiKeyUser(ctx: Context, req: FastifyRequest): Promise<User | null> {
  const token = bearerToken(req)
  return token ? apiKeyUser(ctx, token) : null
}

/** The token of an `Authorization: Bearer <token>` header. */
export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization ?? ''
  const space = header.indexOf(' ')
  if (space < 0) return null
  const token = header.slice(space + 1).trim()
  return header.slice(0, space).toLowerCase() === 'bearer' && token ? token : null
}
