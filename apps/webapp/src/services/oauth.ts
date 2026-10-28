import { apiFetch } from '../lib/apiFetch'

/** An app asking to connect to the user's account (an OAuth authorization request) */
export interface ConsentRequest {
  clientName: string
  /** Where the user is sent back to after deciding */
  redirectUri: string
}

/** An app the user connected, e.g. Claude */
export interface Connection {
  id: number
  clientName: string
  lastUsedAt: string | null
  createdAt: string
}

async function parseError(response: Response): Promise<string> {
  try {
    const data = await response.json()
    if (data && typeof data.message === 'string') return data.message
  } catch {
    // ignore
  }
  return 'Request failed'
}

/** `query` is the consent page's own query string, which the backend's /oauth/authorize sent. */
export async function getConsentRequest(query: string): Promise<ConsentRequest> {
  const response = await apiFetch(`/oauth/consent${query}`)
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

/** Approves or denies the request, returning where to send the user: back to the app. */
export async function submitConsent(query: string, approve: boolean): Promise<string> {
  const response = await apiFetch(`/oauth/consent${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const { redirectTo } = await response.json()
  return redirectTo
}

export async function getConnections(): Promise<Connection[]> {
  const response = await apiFetch('/oauth/connections')
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function disconnect(id: number): Promise<void> {
  const response = await apiFetch(`/oauth/connections/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await parseError(response))
}
