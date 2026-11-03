// OAuth 2.1 for the MCP server, which is how the Claude apps (web, desktop, mobile) connect to it:
// discovery metadata (RFC 9728, RFC 8414), dynamic client registration (RFC 7591), the
// authorization code flow with PKCE, and refresh token rotation.
//
// The flow: Claude registers itself, then sends the user to `GET /oauth/authorize`, which checks
// the request and forwards it to the webapp's `/authorize` page. There the logged-in user approves
// or denies it (`/oauth/consent`) and is sent back to Claude with a code, which Claude exchanges at
// `/oauth/token` for an access token (`exa_…`, accepted by `/mcp` only) and a refresh token
// (`exr_…`). Each approval is a grant: a connection the webapp's settings list and can revoke.

import { createHash } from 'node:crypto'
import { and, desc, eq, gt, lte } from 'drizzle-orm'
import { z } from 'zod'
import type { Context } from '../../context.js'
import { oauthClients, oauthCodes, oauthGrants, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { generateToken, hashToken } from '../../lib/tokens.js'
import { toUser, userColumns, type User } from '../auth/auth.service.js'

const ACCESS_TOKEN_PREFIX = 'exa_'
const REFRESH_TOKEN_PREFIX = 'exr_'
const MINUTE = 60 * 1000
const CODE_LIFETIME_MS = 10 * MINUTE
const ACCESS_TOKEN_LIFETIME_MS = 60 * MINUTE
/** Every refresh issues a new refresh token, so a connection that's in use never expires. */
const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * MINUTE
/** `lastUsedAt` is written at most this often per grant. */
const LAST_USED_RESOLUTION_MS = MINUTE
const MAX_REDIRECT_URIS = 10
const MAX_REDIRECT_URI_LENGTH = 2000
const MAX_CLIENT_NAME_LENGTH = 100

/**
 * A token or registration endpoint error, as OAuth clients expect it (RFC 6749 §5.2):
 * `{ "error": "invalid_grant", "error_description": "…" }`.
 */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
  ) {
    super(description)
  }
}

const later = (instant: Date, ms: number) => new Date(instant.getTime() + ms)

/** The MCP server's URL: the resource every token is for. */
export function resource(ctx: Context): string {
  return `${ctx.config.apiUrl}/mcp`
}

/** Where `/mcp`'s metadata is, for the challenge it answers unauthenticated requests with. */
export function resourceMetadataUrl(ctx: Context): string {
  return `${ctx.config.apiUrl}/.well-known/oauth-protected-resource/mcp`
}

export function resourceMetadata(ctx: Context) {
  return {
    resource: resource(ctx),
    authorization_servers: [ctx.config.apiUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'Expenser',
  }
}

export function serverMetadata(ctx: Context) {
  const issuer = ctx.config.apiUrl
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // Clients are public: they prove themselves with PKCE, not a secret.
    token_endpoint_auth_methods_supported: ['none'],
    // Tokens grant everything `/mcp` offers; this tells clients a refresh token comes with them.
    scopes_supported: ['offline_access'],
  }
}

function isLoopback(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === '[::1]')
  )
}

/**
 * A redirect URI a client may register: HTTPS, or for native apps HTTP on a loopback address
 * (RFC 8252 §7.3). Never with a fragment.
 */
function parseRedirectUri(uri: string): URL | null {
  if (uri.length > MAX_REDIRECT_URI_LENGTH || !URL.canParse(uri)) return null
  const url = new URL(uri)
  const allowed = !url.href.includes('#') && (url.protocol === 'https:' || isLoopback(url))
  return allowed ? url : null
}

type Client = typeof oauthClients.$inferSelect

/**
 * The redirect URI, if it's one of this client's. Loopback URIs match on any port (RFC 8252
 * §7.3), since native apps like Claude Code listen on a new one each time.
 */
function clientRedirectUri(client: Client, uri: string): URL | null {
  if (!URL.canParse(uri)) return null
  const requested = new URL(uri)
  const registered: string[] = JSON.parse(client.redirectUris)
  const matches = registered
    .filter((uri) => URL.canParse(uri))
    .map((uri) => new URL(uri))
    .some((registered) => {
      if (!isLoopback(registered) || !isLoopback(requested)) return requested.href === registered.href
      const onRegisteredPort = new URL(requested)
      onRegisteredPort.port = registered.port
      return onRegisteredPort.href === registered.href
    })
  return matches ? requested : null
}

export const registerBody = z.object({
  redirect_uris: z.array(z.string()).nullish(),
  client_name: z.string().nullish(),
})

/**
 * Dynamic client registration (RFC 7591). Every client is registered as a public one, whatever
 * authentication method it asks for.
 */
export async function registerClient(ctx: Context, body: z.output<typeof registerBody>) {
  const uris = body.redirect_uris ?? []
  if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', `Register 1 to ${MAX_REDIRECT_URIS} redirect_uris`)
  }
  const parsed = uris.map(parseRedirectUri)
  if (parsed.some((uri) => uri === null)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'Redirect URIs must be https, or http on a loopback address, without a fragment',
    )
  }
  const redirectUris = (parsed as URL[]).map((uri) => uri.href)
  const clientName = body.client_name?.trim()
  const name = clientName
    ? Array.from(clientName).slice(0, MAX_CLIENT_NAME_LENGTH).join('')
    : // Named after where it sends people back to, e.g. "claude.ai".
      (parsed[0]?.hostname ?? 'An app')

  const id = generateToken()
  const now = ctx.now()
  await ctx.db.insert(oauthClients).values({ id, name, redirectUris: JSON.stringify(redirectUris), createdAt: now })
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

export const authorizeParams = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  resource: z.string().optional(),
})

type AuthorizeParams = z.output<typeof authorizeParams>

/** An authorization request from a known client, to one of its redirect URIs. */
export class Authorization {
  private constructor(
    readonly client: Client,
    readonly redirectUri: URL,
    readonly params: AuthorizeParams,
  ) {}

  /**
   * Checks the request's client and redirect URI. Until both are known to be valid nothing may be
   * sent to that URI, so these errors are for the user.
   */
  static async check(ctx: Context, params: AuthorizeParams): Promise<Authorization> {
    const invalid = AppError.badRequest('This sign-in link is invalid: unknown app or redirect')
    if (!params.client_id) throw invalid
    const [client] = await ctx.db.select().from(oauthClients).where(eq(oauthClients.id, params.client_id))
    if (!client) throw invalid
    const redirectUri = params.redirect_uri ? clientRedirectUri(client, params.redirect_uri) : null
    if (!redirectUri) throw invalid
    return new Authorization(client, redirectUri, params)
  }

  /** What's wrong with the rest of the request, as an OAuth error code and description. */
  error(ctx: Context): { error: string; description: string } | null {
    const params = this.params
    if (params.response_type !== 'code') {
      return { error: 'unsupported_response_type', description: 'response_type must be code' }
    }
    if (!isPkceValue(params.code_challenge) || params.code_challenge_method !== 'S256') {
      return {
        error: 'invalid_request',
        description: 'A PKCE code_challenge, with code_challenge_method S256, is required',
      }
    }
    if (params.resource !== undefined && params.resource !== resource(ctx)) {
      return { error: 'invalid_target', description: `resource must be ${resource(ctx)}` }
    }
    return null
  }

  /** The redirect URI with these query parameters added, and the request's `state`. */
  redirect(params: Record<string, string>): string {
    const url = new URL(this.redirectUri)
    for (const [name, value] of Object.entries(params)) url.searchParams.append(name, value)
    if (this.params.state !== undefined) url.searchParams.append('state', this.params.state)
    return url.href
  }
}

/** A PKCE code verifier or challenge: 43 to 128 unreserved characters (RFC 7636 §4.1). */
function isPkceValue(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9\-._~]{43,128}$/.test(value)
}

/** The S256 challenge of a PKCE code verifier. */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * An authorization request the user can decide on. The webapp passes on the query it was sent,
 * which `/oauth/authorize` already checked, so any error here is explained to the user.
 */
export async function decidable(ctx: Context, params: AuthorizeParams): Promise<Authorization> {
  const request = await Authorization.check(ctx, params)
  const error = request.error(ctx)
  if (error) throw AppError.badRequest(error.description)
  return request
}

/** The user's decision: where the webapp sends them, the client's redirect URI with a code or an error. */
export async function decide(ctx: Context, user: User, request: Authorization, approve: boolean): Promise<string> {
  if (!approve) return request.redirect({ error: 'access_denied' })

  const code = generateToken()
  const now = ctx.now()
  await ctx.db.delete(oauthCodes).where(lte(oauthCodes.expiresAt, now))
  await ctx.db.insert(oauthCodes).values({
    codeHash: hashToken(code),
    clientId: request.client.id,
    userId: user.id,
    redirectUri: request.redirectUri.href,
    // `decidable` checked it's there.
    codeChallenge: request.params.code_challenge ?? '',
    expiresAt: later(now, CODE_LIFETIME_MS),
  })
  return request.redirect({ code })
}

export const tokenParams = z.object({
  grant_type: z.string().optional(),
  client_id: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  resource: z.string().optional(),
})

type TokenParams = z.output<typeof tokenParams>

/** The token endpoint: exchanges a code, or a refresh token, for new tokens. */
export async function issueTokens(ctx: Context, params: TokenParams) {
  const clientId = params.client_id
  if (!clientId) throw new OAuthError('invalid_request', 'client_id is required')
  if (params.resource !== undefined && params.resource !== resource(ctx)) {
    throw new OAuthError('invalid_target', `resource must be ${resource(ctx)}`)
  }
  switch (params.grant_type) {
    case 'authorization_code':
      return exchangeCode(ctx, clientId, params)
    case 'refresh_token':
      return refresh(ctx, clientId, params)
    default:
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  }
}

function generateTokens() {
  return {
    access_token: generateToken(ACCESS_TOKEN_PREFIX),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_LIFETIME_MS / 1000,
    refresh_token: generateToken(REFRESH_TOKEN_PREFIX),
  }
}

/** Starts a grant: the user's connection to the client. */
async function exchangeCode(ctx: Context, clientId: string, params: TokenParams) {
  const invalid = new OAuthError('invalid_grant', 'The code is invalid, expired or used')
  if (!params.code) throw invalid
  // Deleted as it's read, so it works once, even when two requests race.
  const [code] = await ctx.db.delete(oauthCodes).where(eq(oauthCodes.codeHash, hashToken(params.code))).returning()
  if (!code) throw invalid
  const now = ctx.now()
  const redirectUri = params.redirect_uri && URL.canParse(params.redirect_uri) ? new URL(params.redirect_uri).href : null
  if (code.expiresAt.getTime() <= now.getTime() || code.clientId !== clientId || redirectUri !== code.redirectUri) {
    throw invalid
  }
  const verifier = params.code_verifier
  if (!isPkceValue(verifier) || pkceChallenge(verifier) !== code.codeChallenge) {
    throw new OAuthError('invalid_grant', "code_verifier doesn't match the code_challenge")
  }

  const tokens = generateTokens()
  await ctx.db.delete(oauthGrants).where(lte(oauthGrants.refreshExpiresAt, now))
  await ctx.db.insert(oauthGrants).values({
    clientId: code.clientId,
    userId: code.userId,
    accessTokenHash: hashToken(tokens.access_token),
    accessExpiresAt: later(now, ACCESS_TOKEN_LIFETIME_MS),
    refreshTokenHash: hashToken(tokens.refresh_token),
    refreshExpiresAt: later(now, REFRESH_TOKEN_LIFETIME_MS),
    createdAt: now,
  })
  return tokens
}

/** Replaces a grant's tokens. The old refresh token stops working, as does the old access token. */
async function refresh(ctx: Context, clientId: string, params: TokenParams) {
  if (!params.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required')
  const tokens = generateTokens()
  const now = ctx.now()
  // One UPDATE, so a refresh token works once, even when two requests race.
  const rotated = await ctx.db
    .update(oauthGrants)
    .set({
      accessTokenHash: hashToken(tokens.access_token),
      accessExpiresAt: later(now, ACCESS_TOKEN_LIFETIME_MS),
      refreshTokenHash: hashToken(tokens.refresh_token),
      refreshExpiresAt: later(now, REFRESH_TOKEN_LIFETIME_MS),
    })
    .where(
      and(
        eq(oauthGrants.refreshTokenHash, hashToken(params.refresh_token)),
        eq(oauthGrants.clientId, clientId),
        gt(oauthGrants.refreshExpiresAt, now),
      ),
    )
    .returning({ id: oauthGrants.id })
  if (rotated.length === 0) {
    throw new OAuthError('invalid_grant', 'The refresh token is invalid, expired or revoked')
  }
  return tokens
}

/** The user an `exa_…` access token was issued to, while it's current. */
export async function accessTokenUser(ctx: Context, token: string): Promise<User | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null
  const now = ctx.now()
  const [owner] = await ctx.db
    .select({ ...userColumns, grantId: oauthGrants.id, lastUsedAt: oauthGrants.lastUsedAt })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthGrants.accessTokenHash, hashToken(token)), gt(oauthGrants.accessExpiresAt, now)))
  if (!owner) return null

  if (!owner.lastUsedAt || now.getTime() - owner.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await ctx.db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, owner.grantId))
  }
  return toUser(owner)
}

/** The apps the user has connected, newest first. */
export function listConnections(ctx: Context, userId: number) {
  return ctx.db
    .select({
      id: oauthGrants.id,
      clientName: oauthClients.name,
      lastUsedAt: oauthGrants.lastUsedAt,
      createdAt: oauthGrants.createdAt,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, userId), gt(oauthGrants.refreshExpiresAt, ctx.now())))
    .orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id))
}

/** Revokes a connection: its access and refresh tokens stop working at once. */
export async function disconnect(ctx: Context, userId: number, id: number): Promise<void> {
  const deleted = await ctx.db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, userId)))
    .returning({ id: oauthGrants.id })
  if (deleted.length === 0) throw AppError.notFound('Connection not found')
}
