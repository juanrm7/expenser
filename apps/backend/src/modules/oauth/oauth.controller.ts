import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { requireSessionUser } from '../../lib/auth.js'
import { parse, parseId } from '../../lib/errors.js'
import {
  Authorization,
  authorizeParams,
  decidable,
  decide,
  disconnect,
  issueTokens,
  listConnections,
  OAuthError,
  registerBody,
  registerClient,
  resourceMetadata,
  serverMetadata,
  tokenParams,
} from './oauth.service.js'

const consentBody = z.object({ approve: z.boolean() })

export function oauthController(ctx: Context): FastifyPluginAsync {
  return async (app) => {
    app.get('/.well-known/oauth-protected-resource', async () => resourceMetadata(ctx))
    app.get('/.well-known/oauth-protected-resource/mcp', async () => resourceMetadata(ctx))
    app.get('/.well-known/oauth-authorization-server', async () => serverMetadata(ctx))

    // The authorization endpoint: errors in a request from a valid client go back to it; valid
    // requests go on to the webapp, where the user approves or denies them.
    app.get('/oauth/authorize', async (req, reply) => {
      const request = await Authorization.check(ctx, parse(authorizeParams, req.query))
      const error = request.error(ctx)
      if (error) {
        return reply.redirect(request.redirect({ error: error.error, error_description: error.description }), 303)
      }
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : ''
      return reply.redirect(`${ctx.config.webappUrl}/authorize?${query}`, 303)
    })

    // What the consent page shows: who's asking, and where they'll be sent back to. Both consent
    // routes need a logged-in browser (`requireSessionUser`), so an API key can't grant access.
    app.get('/oauth/consent', async (req) => {
      await requireSessionUser(ctx, req)
      const request = await decidable(ctx, parse(authorizeParams, req.query))
      return { clientName: request.client.name, redirectUri: request.redirectUri.href }
    })

    app.post('/oauth/consent', async (req) => {
      const user = await requireSessionUser(ctx, req)
      const request = await decidable(ctx, parse(authorizeParams, req.query))
      const { approve } = parse(consentBody, req.body)
      return { redirectTo: await decide(ctx, user, request, approve) }
    })

    app.get('/oauth/connections', async (req) => {
      const user = await requireSessionUser(ctx, req)
      return listConnections(ctx, user.id)
    })

    app.delete<{ Params: { id: string } }>('/oauth/connections/:id', async (req, reply) => {
      const user = await requireSessionUser(ctx, req)
      await disconnect(ctx, user.id, parseId(req.params.id))
      return reply.status(204).send()
    })

    app.register(protocolEndpoints(ctx))
  }
}

/**
 * Registration and the token endpoint, which OAuth clients rather than the webapp call: their
 * errors are `{ error, error_description }`, and they read the raw body themselves (JSON for
 * registration, a form for tokens) so that a malformed one gets such an error too.
 */
function protocolEndpoints(ctx: Context): FastifyPluginAsync {
  return async (app) => {
    app.removeAllContentTypeParsers()
    app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body))

    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof OAuthError) {
        return reply.status(400).send({ error: err.error, error_description: err.description })
      }
      const status = (err as { statusCode?: number }).statusCode ?? 500
      if (status >= 400 && status < 500) {
        return reply.status(status).send({ error: 'invalid_request', error_description: (err as Error).message })
      }
      return reply.status(500).send({ error: 'server_error' })
    })

    app.post('/oauth/register', async (req, reply) => {
      const client = await registerClient(ctx, oauthParse(registerBody, jsonBody(req.body), 'invalid_client_metadata'))
      reply.status(201)
      return client
    })

    app.post('/oauth/token', async (req, reply) => {
      const params = oauthParse(tokenParams, formBody(req.headers['content-type'], req.body), 'invalid_request')
      const tokens = await issueTokens(ctx, params)
      reply.header('cache-control', 'no-store')
      return tokens
    })
  }
}

function jsonBody(body: unknown): unknown {
  try {
    return JSON.parse(typeof body === 'string' ? body : '')
  } catch (err) {
    throw new OAuthError('invalid_client_metadata', `The body must be JSON: ${(err as Error).message}`)
  }
}

/** An `application/x-www-form-urlencoded` body, as OAuth requires (RFC 6749 §4.1.3). */
function formBody(contentType: string | undefined, body: unknown): Record<string, string> {
  if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 'The body must be application/x-www-form-urlencoded')
  }
  const entries = [...new URLSearchParams(typeof body === 'string' ? body : '')]
  const params = Object.fromEntries(entries)
  if (Object.keys(params).length !== entries.length) {
    throw new OAuthError('invalid_request', 'Parameters must not be repeated')
  }
  return params
}

function oauthParse<Schema extends z.ZodType>(schema: Schema, value: unknown, error: string): z.output<Schema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const [issue] = result.error.issues
  throw new OAuthError(error, `${issue?.path.join('.') || 'body'}: ${issue?.message}`)
}
