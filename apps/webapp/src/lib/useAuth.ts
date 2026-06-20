import { useEffect, useState } from 'react'
import { getCurrentUser, type AuthUser } from '../services/auth'
import { clearCache, readUserCache, writeUserCache } from './cache'

interface UseAuthState {
  user: AuthUser | null
  loading: boolean
}

export function useAuth(): UseAuthState {
  const [state, setState] = useState<UseAuthState>({ user: null, loading: true })

  useEffect(() => {
    let cancelled = false

    // Show the cached user immediately so the UI can paint, then revalidate.
    const cached = readUserCache()
    if (cached) setState({ user: cached, loading: false })

    async function load() {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        if (!user) {
          clearCache()
          window.location.href = '/login'
          return
        }
        writeUserCache(user)
        setState({ user, loading: false })
      } catch {
        if (cancelled) return
        // Network error: keep showing the cached user if we have one,
        // otherwise there's nothing to show — send them to login.
        if (!readUserCache()) window.location.href = '/login'
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
