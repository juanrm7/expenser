// The MCP server at `/mcp`, built on the official TypeScript SDK (v2).
//
// Clients authenticate with an `Authorization: Bearer` OAuth access token (the Claude apps, see
// modules/oauth) or API key (`exp_…`, e.g. Claude Code). Session cookies aren't accepted, so a web
// page can't make a logged-in browser call it. There are no MCP sessions: each request is served on
// its own, by a server for the token's owner, and answered with JSON.
//
// Both protocol eras are served: 2026-07-28 requests (each carrying its protocol version) by the
// SDK's `createMcpHandler`, and 2025-era ones (`initialize` first) by a stateless transport.

import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpServer,
} from '@modelcontextprotocol/server'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Context } from '../../context.js'
import { bearerApiKeyUser, bearerToken } from '../../lib/auth.js'
import type { User } from '../auth/auth.service.js'
import { accessTokenUser, resourceMetadataUrl } from '../oauth/oauth.service.js'
import { buildMcpServer } from './mcp.server.js'

/** What the route hands the per-request server factory, through the SDK's `authInfo`. */
interface Principal {
  user: User
  correlationId: string
}

export function mcpController(ctx: Context): FastifyPluginAsync {
  const modern = createMcpHandler(
    ({ authInfo }) => {
      const { user, correlationId } = authInfo?.extra as unknown as Principal
      return buildMcpServer(ctx, user, correlationId)
    },
    { legacy: 'reject' },
  )

  return async (app) => {
    // The SDK reads and validates the body itself.
    app.removeAllContentTypeParsers()
    app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body))

    app.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (req, reply) => {
        const token = bearerToken(req)
        const user = token ? ((await accessTokenUser(ctx, token)) ?? (await bearerApiKeyUser(ctx, req))) : null
        if (!token || !user) {
          // Tells OAuth clients where to find out how to get a token (RFC 9728).
          return reply
            .status(401)
            .header('www-authenticate', `Bearer resource_metadata="${resourceMetadataUrl(ctx)}"`)
            .send({ message: 'Unauthorized' })
        }
        req.user = user

        const request = toWebRequest(ctx, req)
        let response: Response
        if (await isLegacyRequest(request)) {
          response = await serveLegacy(buildMcpServer(ctx, user, req.id), request)
        } else {
          const principal: Principal = { user, correlationId: req.id }
          const authInfo: AuthInfo = { token, clientId: 'expenser', scopes: [], extra: { ...principal } }
          response = await modern.fetch(request, { authInfo })
        }
        return send(reply, response)
      },
    })

    app.addHook('onClose', () => modern.close())
  }
}

/** Serves a 2025-era request statelessly: no sessions, so only POSTs, and JSON responses. */
async function serveLegacy(server: McpServer, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    const error = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }
    return Response.json(error, { status: 405, headers: { allow: 'POST' } })
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}

function toWebRequest(ctx: Context, req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item)
  }
  return new Request(new URL(req.url, ctx.config.apiUrl), {
    method: req.method,
    headers,
    body: req.method === 'POST' && typeof req.body === 'string' ? req.body : undefined,
  })
}

async function send(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.status(response.status)
  response.headers.forEach((value, name) => reply.header(name, value))
  if (!response.body) return reply.send()
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    // The SDK streams a reply only when a handler sends messages before its result, or for
    // subscriptions/listen. nginx must then pass events on as they come.
    reply.header('x-accel-buffering', 'no')
    return reply.send(Readable.fromWeb(response.body as NodeReadableStream))
  }
  return reply.send(Buffer.from(await response.arrayBuffer()))
}
