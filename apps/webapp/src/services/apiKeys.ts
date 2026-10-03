import { apiFetch } from '../lib/apiFetch'

export interface ApiKey {
  id: number
  name: string
  /** First characters of the key, for telling keys apart */
  prefix: string
  lastUsedAt: string | null
  createdAt: string
}

/** Only returned by createApiKey — the full key is never retrievable again */
export interface CreatedApiKey extends ApiKey {
  key: string
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

export async function getApiKeys(): Promise<ApiKey[]> {
  const response = await apiFetch('/api-keys')
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function createApiKey(name: string): Promise<CreatedApiKey> {
  const response = await apiFetch('/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function revokeApiKey(id: number): Promise<void> {
  const response = await apiFetch(`/api-keys/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await parseError(response))
}
