/**
 * Where to go after logging in or signing up: the `?next=` path, so a page that needed a login
 * (like the consent page an app sends you to) picks up where it left off. Only same-origin
 * destinations count, so a crafted link can't send you to another site.
 */
export function readNext(): string {
  const next = new URLSearchParams(window.location.search).get('next')
  if (!next) return '/'
  try {
    const url = new URL(next, window.location.origin)
    if (url.origin === window.location.origin) return url.pathname + url.search + url.hash
  } catch {
    // not a URL
  }
  return '/'
}

/** A link to `path` that keeps `next`. */
export function withNext(path: string, next: string): string {
  return next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`
}

/** The login page, coming back to the current page afterwards. */
export function loginUrl(): string {
  return withNext('/login', window.location.pathname + window.location.search)
}
