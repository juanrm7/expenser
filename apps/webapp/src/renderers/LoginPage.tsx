import { useEffect, useState } from 'react'
import { readNext } from '../lib/next'
import { getCurrentUser } from '../services/auth'
import { LoginForm } from '../templates/LoginForm'

export function LoginPage() {
  const [checking, setChecking] = useState(true)
  const [next, setNext] = useState('/')

  useEffect(() => {
    let cancelled = false
    const target = readNext()
    setNext(target)
    async function check() {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        if (user) {
          window.location.href = target
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

  return <LoginForm next={next} />
}
