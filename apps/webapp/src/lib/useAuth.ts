import { useEffect, useState } from 'react'
import { getCurrentUser, type AuthUser } from '../services/auth'

interface UseAuthState {
  user: AuthUser | null
  loading: boolean
}

export function useAuth(): UseAuthState {
  const [state, setState] = useState<UseAuthState>({ user: null, loading: true })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        if (!user) {
          window.location.href = '/login'
          return
        }
        setState({ user, loading: false })
      } catch {
        if (cancelled) return
        window.location.href = '/login'
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
