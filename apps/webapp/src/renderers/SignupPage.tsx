import { useEffect, useState } from 'react'
import { getCurrentUser } from '../services/auth'
import { SignupForm } from '../templates/SignupForm'

export function SignupPage() {
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        if (user) {
          window.location.href = '/'
          return
        }
        setChecking(false)
      } catch {
        if (cancelled) return
        setChecking(false)
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  if (checking) return null

  return <SignupForm />
}
