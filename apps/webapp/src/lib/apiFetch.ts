import { env } from '../config/environment'

const HEADER_NAME = 'x-correlation-id'

function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback: rfc4122-ish random id
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function statusStyle(status: number): string {
  if (status >= 500) return 'color: #ef4444; font-weight: bold'
  if (status >= 400) return 'color: #f59e0b; font-weight: bold'
  if (status >= 300) return 'color: #06b6d4'
  if (status >= 200) return 'color: #10b981'
  return 'color: #6b7280'
}

export interface ApiFetchOptions extends RequestInit {
  /** Skip prefixing the URL with backendUrl (use the full URL as provided). */
  absolute?: boolean
}

/**
 * Wrapper around fetch that:
 * - Prefixes paths with the backend URL.
 * - Generates an `x-correlation-id` header per request.
 * - Always includes credentials.
 * - Logs a single colored line per request: `[corrId] METHOD url -> status (duration ms)`
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { absolute, headers, ...rest } = options
  const url = absolute ? path : `${env.backendUrl}${path}`
  const correlationId = generateCorrelationId()
  const method = (rest.method ?? 'GET').toUpperCase()

  const mergedHeaders = new Headers(headers)
  mergedHeaders.set(HEADER_NAME, correlationId)

  const start = performance.now()
  let response: Response
  try {
    response = await fetch(url, {
      ...rest,
      headers: mergedHeaders,
      credentials: 'include',
    })
  } catch (err) {
    const duration = (performance.now() - start).toFixed(1)
    console.error(
      `%c[${shortId(correlationId)}]%c ${method} ${url} %cNETWORK_ERROR%c (${duration}ms)`,
      'color: #a855f7; font-weight: bold',
      'color: inherit',
      'color: #ef4444; font-weight: bold',
      'color: #6b7280',
      err
    )
    throw err
  }

  const duration = (performance.now() - start).toFixed(1)
  // Backend echoes the correlation id back; prefer it if present
  const echoed = response.headers.get(HEADER_NAME) ?? correlationId

  console.log(
    `%c[${shortId(echoed)}]%c ${method} ${url} %c${response.status}%c (${duration}ms)`,
    'color: #a855f7; font-weight: bold',
    'color: inherit',
    statusStyle(response.status),
    'color: #6b7280'
  )

  return response
}
