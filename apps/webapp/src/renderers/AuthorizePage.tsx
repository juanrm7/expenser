import { useEffect, useState } from 'react'
import { useAuth } from '../lib/useAuth'
import { getConsentRequest, submitConsent, type ConsentRequest } from '../services/oauth'
import { AuthorizeConsent } from '../templates/AuthorizeConsent'

/**
 * Where the backend's /oauth/authorize sends an app's sign-in request (e.g. Claude connecting):
 * the user approves or denies it, and is sent back to the app.
 */
export function AuthorizePage() {
  const { user, loading } = useAuth()
  const [request, setRequest] = useState<ConsentRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Inside another site's frame, the buttons could be disguised to trick you into approving.
    if (window.self !== window.top) {
      setError("For your security, this page can't be shown inside another site.")
      return
    }
    if (!user) return
    getConsentRequest(window.location.search).then(setRequest, (err: unknown) =>
      setError(err instanceof Error ? err.message : 'This sign-in link is invalid')
    )
  }, [user])

  async function decide(approve: boolean) {
    window.location.href = await submitConsent(window.location.search, approve)
  }

  if (loading || !user) return null

  return <AuthorizeConsent user={user} request={request} error={error} onDecide={decide} />
}
