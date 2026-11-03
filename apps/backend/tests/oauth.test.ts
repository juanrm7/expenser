// OAuth for the MCP server: discovery, client registration, the authorization code flow with PKCE,
// refresh token rotation, and connections.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { iso, NOW, TestApp, type TestResponse } from './helpers.js'

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
const RESOURCE = 'https://api.example.com/mcp'
const VERIFIER = 'a-pkce-code-verifier-of-at-least-43-characters'

async function setup(t: TestContext) {
  const app = await TestApp.spawn(t)
  await app.seedUsers()
  return app
}

function register(app: TestApp, redirectUris: unknown) {
  return app.request('POST', '/oauth/register', { client_name: 'Claude', redirect_uris: redirectUris })
}

async function clientId(app: TestApp, redirectUri = REDIRECT_URI): Promise<string> {
  const response = await register(app, [redirectUri])
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body.client_id
}

/** The query of an authorization request, with these parameters changed (`null` removes one). */
function authorizeQuery(clientId: string, changes: Record<string, string | null | undefined> = {}): string {
  const params: Record<string, string | null | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: RESOURCE,
    scope: 'offline_access',
    ...changes,
  }
  const present = Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return new URLSearchParams(present).toString()
}

/** A query parameter of a URL. */
const param = (url: string, name: string) => new URL(url).searchParams.get(name)

/** User 1 approves the request, returning the code it was redirected with. */
async function approve(app: TestApp, query: string): Promise<string> {
  const response = await app.post(`/oauth/consent?${query}`, { approve: true })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const { redirectTo } = response.body
  assert.equal(param(redirectTo, 'state'), 'xyz')
  return param(redirectTo, 'code')!
}

function exchange(app: TestApp, clientId: string, code: string, verifier: string) {
  return app.postForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: RESOURCE,
  })
}

function refresh(app: TestApp, clientId: string, refreshToken: string) {
  return app.postForm('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken })
}

/** Registers a client and connects user 1 to it, returning the client id and the tokens. */
async function connect(app: TestApp) {
  const client = await clientId(app)
  const code = await approve(app, authorizeQuery(client))
  const response = await exchange(app, client, code, VERIFIER)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return { clientId: client, tokens: response.body }
}

/** The status of an MCP request authenticated with `token`, and the user id it saw. */
async function mcpUser(app: TestApp, token: string): Promise<[number, number | null]> {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_profile', arguments: {} } }
  const response = await app.request('POST', '/mcp', body, {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  })
  const text = response.body?.result?.content?.[0]?.text
  return [response.status, text ? JSON.parse(text).id : null]
}

const error = (response: TestResponse) => [response.status, response.body.error]

test('discovery metadata points clients at every endpoint', async (t) => {
  const app = await setup(t)
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const resource = (await app.request('GET', path)).body
    assert.equal(resource.resource, RESOURCE, path)
    assert.deepEqual(resource.authorization_servers, ['https://api.example.com'])
  }

  const server = (await app.request('GET', '/.well-known/oauth-authorization-server')).body
  assert.equal(server.issuer, 'https://api.example.com')
  for (const [field, path] of [
    ['authorization_endpoint', '/oauth/authorize'],
    ['token_endpoint', '/oauth/token'],
    ['registration_endpoint', '/oauth/register'],
  ]) {
    assert.equal(server[field!], `https://api.example.com${path}`)
  }
  assert.deepEqual(server.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ['none'])
})

test('clients register https or loopback redirect URIs', async (t) => {
  const app = await setup(t)

  const response = await register(app, [REDIRECT_URI, 'http://localhost:3118/callback'])
  assert.equal(response.status, 201, JSON.stringify(response.body))
  const client = response.body
  assert.ok(client.client_id.length >= 43)
  assert.equal(client.client_name, 'Claude')
  assert.equal(client.token_endpoint_auth_method, 'none')
  assert.equal(client.client_id_issued_at, Math.floor(NOW.getTime() / 1000))
  assert.deepEqual(client.redirect_uris, [REDIRECT_URI, 'http://localhost:3118/callback'])

  const unnamed = await app.request('POST', '/oauth/register', {
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'client_secret_basic',
  })
  assert.equal(unnamed.body.client_name, 'claude.ai')
  assert.equal(unnamed.body.token_endpoint_auth_method, 'none')

  for (const redirectUris of [
    [],
    Array(11).fill(REDIRECT_URI),
    ['http://example.com/callback'],
    ['https://claude.ai/callback#fragment'],
    ['https://claude.ai/callback#'],
    ['javascript:alert(1)'],
    [REDIRECT_URI, 'not a url'],
  ]) {
    const response = await register(app, redirectUris)
    assert.deepEqual(error(response), [400, 'invalid_redirect_uri'], JSON.stringify(redirectUris))
  }
  const empty = await app.request('POST', '/oauth/register', undefined, { 'content-type': 'application/json' })
  assert.deepEqual(error(empty), [400, 'invalid_client_metadata'])
  const wrongType = await app.request('POST', '/oauth/register', { redirect_uris: REDIRECT_URI })
  assert.deepEqual(error(wrongType), [400, 'invalid_client_metadata'])
})

test('authorization requests are checked before reaching the consent page', async (t) => {
  const app = await setup(t)
  const client = await clientId(app)

  const query = authorizeQuery(client)
  const response = await app.request('GET', `/oauth/authorize?${query}`)
  assert.equal(response.status, 303)
  assert.equal(response.headers.location, `http://localhost:4321/authorize?${query}`)

  // Until the client and redirect URI check out, nothing is sent to the redirect URI.
  for (const changes of [
    { client_id: 'unknown' },
    { client_id: null },
    { redirect_uri: 'https://claude.ai/elsewhere' },
    { redirect_uri: null },
  ]) {
    const response = await app.request('GET', `/oauth/authorize?${authorizeQuery(client, changes)}`)
    assert.equal(response.status, 400, JSON.stringify(changes))
    assert.equal(response.body.message, 'This sign-in link is invalid: unknown app or redirect')
  }

  for (const [changes, expected] of [
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ code_challenge: null }, 'invalid_request'],
    [{ code_challenge: 'short' }, 'invalid_request'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: null }, 'invalid_request'],
    [{ resource: 'https://elsewhere.example.com/mcp' }, 'invalid_target'],
  ] as const) {
    const response = await app.request('GET', `/oauth/authorize?${authorizeQuery(client, changes)}`)
    assert.equal(response.status, 303, JSON.stringify(changes))
    const location = response.headers.location!
    assert.ok(location.startsWith(REDIRECT_URI), location)
    assert.equal(param(location, 'error'), expected, JSON.stringify(changes))
    assert.equal(param(location, 'state'), 'xyz')
  }
})

test('loopback redirect URIs match on any port', async (t) => {
  const app = await setup(t)
  const client = await clientId(app, 'http://localhost:3118/callback')
  for (const [redirectUri, status] of [
    ['http://localhost:3118/callback', 303],
    ['http://localhost:54321/callback', 303],
    ['http://localhost:54321/other', 400],
    ['http://127.0.0.1:3118/callback', 400],
    ['https://localhost:3118/callback', 400],
  ] as const) {
    const response = await app.request('GET', `/oauth/authorize?${authorizeQuery(client, { redirect_uri: redirectUri })}`)
    assert.equal(response.status, status, redirectUri)
  }

  const query = authorizeQuery(client, { redirect_uri: 'http://localhost:54321/callback' })
  const { redirectTo } = (await app.post(`/oauth/consent?${query}`, { approve: true })).body
  assert.ok(redirectTo.startsWith('http://localhost:54321/callback?code='), redirectTo)
})

test('only a logged-in user approves or denies on the consent page', async (t) => {
  const app = await setup(t)
  const client = await clientId(app)
  const url = `/oauth/consent?${authorizeQuery(client)}`

  assert.equal((await app.request('GET', url)).status, 401)
  const { key } = (await app.post('/api-keys', { name: 'k' })).body
  const withKey = { authorization: `Bearer ${key}` }
  assert.equal((await app.request('GET', url, undefined, withKey)).status, 403)
  assert.equal((await app.request('POST', url, { approve: true }, withKey)).status, 403)

  const request = await app.get(url)
  assert.equal(request.status, 200)
  assert.deepEqual(request.body, { clientName: 'Claude', redirectUri: REDIRECT_URI })

  const { redirectTo } = (await app.post(url, { approve: false })).body
  assert.equal(param(redirectTo, 'error'), 'access_denied')
  assert.equal(param(redirectTo, 'state'), 'xyz')
  assert.equal(param(redirectTo, 'code'), null)

  const tampered = await app.get(`/oauth/consent?${authorizeQuery(client, { code_challenge: null })}`)
  assert.equal(tampered.status, 400)
  assert.match(tampered.body.message, /PKCE/)
})

test('codes are exchanged once, with their verifier, client and redirect URI', async (t) => {
  const app = await setup(t)
  const client = await clientId(app)
  const otherClient = await clientId(app)
  const query = authorizeQuery(client)

  let code = await approve(app, query)
  assert.deepEqual(error(await exchange(app, client, code, 'x'.repeat(43))), [400, 'invalid_grant'])
  // A failed attempt uses the code up too.
  assert.deepEqual(error(await exchange(app, client, code, VERIFIER)), [400, 'invalid_grant'])

  code = await approve(app, query)
  assert.deepEqual(error(await exchange(app, otherClient, code, VERIFIER)), [400, 'invalid_grant'])
  code = await approve(app, query)
  const elsewhere = await app.postForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: client,
    code,
    redirect_uri: 'https://claude.ai/elsewhere',
    code_verifier: VERIFIER,
  })
  assert.deepEqual(error(elsewhere), [400, 'invalid_grant'])

  code = await approve(app, query)
  await app.execute('UPDATE OAuthCode SET expiresAt = ?1', [NOW])
  assert.deepEqual(error(await exchange(app, client, code, VERIFIER)), [400, 'invalid_grant'])

  code = await approve(app, query)
  const response = await exchange(app, client, code, VERIFIER)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.headers['cache-control'], 'no-store')
  const tokens = response.body
  assert.ok(tokens.access_token.startsWith('exa_'))
  assert.ok(tokens.refresh_token.startsWith('exr_'))
  assert.equal(tokens.token_type, 'Bearer')
  assert.equal(tokens.expires_in, 3600)
  assert.deepEqual(error(await exchange(app, client, code, VERIFIER)), [400, 'invalid_grant'])

  for (const [form, expected] of [
    [{ grant_type: 'password', client_id: 'x' }, 'unsupported_grant_type'],
    [{ grant_type: 'authorization_code' }, 'invalid_request'],
    [{ grant_type: 'refresh_token', client_id: client }, 'invalid_request'],
    [
      { grant_type: 'authorization_code', client_id: client, resource: 'https://elsewhere.example.com/mcp' },
      'invalid_target',
    ],
  ] as const) {
    assert.deepEqual(error(await app.postForm('/oauth/token', form)), [400, expected], JSON.stringify(form))
  }
  const json = await app.request('POST', '/oauth/token', { grant_type: 'refresh_token' })
  assert.deepEqual(error(json), [400, 'invalid_request'])
  const repeated = await app.send({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `grant_type=refresh_token&client_id=${client}&client_id=other&refresh_token=x`,
  })
  assert.deepEqual(error(repeated), [400, 'invalid_request'])
})

test('access tokens work on /mcp only, and refreshing rotates both tokens', async (t) => {
  const app = await setup(t)
  const { clientId: client, tokens } = await connect(app)
  const access = tokens.access_token
  const refreshToken = tokens.refresh_token

  assert.deepEqual(await mcpUser(app, access), [200, 1])
  assert.equal((await app.request('GET', '/auth/me', undefined, { authorization: `Bearer ${access}` })).status, 401)

  const otherClient = await clientId(app)
  assert.deepEqual(error(await refresh(app, otherClient, refreshToken)), [400, 'invalid_grant'])

  const refreshed = await refresh(app, client, refreshToken)
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
  const newAccess = refreshed.body.access_token
  assert.notEqual(newAccess, access)
  assert.deepEqual(await mcpUser(app, newAccess), [200, 1])
  assert.equal((await mcpUser(app, access))[0], 401)
  assert.deepEqual(error(await refresh(app, client, refreshToken)), [400, 'invalid_grant'])

  await app.execute('UPDATE OAuthGrant SET accessExpiresAt = ?1', [NOW])
  assert.equal((await mcpUser(app, newAccess))[0], 401)
  const again = await refresh(app, client, refreshed.body.refresh_token)
  assert.deepEqual(await mcpUser(app, again.body.access_token), [200, 1])

  await app.execute('UPDATE OAuthGrant SET refreshExpiresAt = ?1', [NOW])
  assert.deepEqual(error(await refresh(app, client, again.body.refresh_token)), [400, 'invalid_grant'])
})

test('users list and revoke their connections', async (t) => {
  const app = await setup(t)
  const { clientId: client, tokens } = await connect(app)
  assert.equal((await mcpUser(app, tokens.access_token))[0], 200)

  const listed = await app.get('/oauth/connections')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body, [{ id: 1, clientName: 'Claude', lastUsedAt: iso(NOW), createdAt: iso(NOW) }])
  const user2 = { cookie: 'session_id=session-2' }
  assert.deepEqual((await app.request('GET', '/oauth/connections', undefined, user2)).body, [])
  const gone = await app.request('DELETE', '/oauth/connections/1', undefined, user2)
  assert.equal(gone.status, 404)
  assert.equal(gone.body.message, 'Connection not found')

  assert.equal((await app.delete('/oauth/connections/1')).status, 204)
  assert.equal((await mcpUser(app, tokens.access_token))[0], 401)
  assert.deepEqual(error(await refresh(app, client, tokens.refresh_token)), [400, 'invalid_grant'])
  assert.deepEqual((await app.get('/oauth/connections')).body, [])
  assert.equal((await app.delete('/oauth/connections/1')).status, 404)

  await connect(app)
  await app.execute('UPDATE OAuthGrant SET refreshExpiresAt = ?1', [NOW])
  assert.deepEqual((await app.get('/oauth/connections')).body, [])
  const { key } = (await app.post('/api-keys', { name: 'k' })).body
  const withKey = await app.request('GET', '/oauth/connections', undefined, { authorization: `Bearer ${key}` })
  assert.equal(withKey.status, 403)
})
