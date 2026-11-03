import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { Context } from '../../context.js'
import { requireUser } from '../../lib/auth.js'
import { parse } from '../../lib/errors.js'
import {
  endSession,
  login,
  loginBody,
  SESSION_COOKIE,
  SESSION_DAYS,
  signup,
  signupBody,
  startSession,
  updateProfile,
  updateProfileBody,
} from './auth.service.js'

export function authController(ctx: Context): FastifyPluginAsync {
  const setSessionCookie = (reply: FastifyReply, value: string, maxAge: number) =>
    reply.setCookie(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: ctx.config.cookieSameSite,
      secure: ctx.config.cookieSecure,
      path: '/',
      maxAge,
    })

  return async (app) => {
    app.post('/auth/signup', async (req, reply) => {
      const user = await signup(ctx, parse(signupBody, req.body))
      setSessionCookie(reply, await startSession(ctx, user.id), SESSION_DAYS * 24 * 60 * 60)
      reply.status(201)
      return user
    })

    app.post('/auth/login', async (req, reply) => {
      const user = await login(ctx, parse(loginBody, req.body))
      setSessionCookie(reply, await startSession(ctx, user.id), SESSION_DAYS * 24 * 60 * 60)
      return user
    })

    app.post('/auth/logout', async (req, reply) => {
      await requireUser(ctx, req)
      const sessionId = req.cookies[SESSION_COOKIE]
      if (sessionId) await endSession(ctx, sessionId)
      setSessionCookie(reply, '', 0)
      return reply.status(204).send()
    })

    app.get('/auth/me', async (req) => requireUser(ctx, req))

    app.patch('/auth/me', async (req) => {
      const user = await requireUser(ctx, req)
      return updateProfile(ctx, user, parse(updateProfileBody, req.body))
    })
  }
}
