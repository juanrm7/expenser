import { useState } from 'react'
import { Plug } from 'lucide-react'
import type { AuthUser } from '../services/auth'
import type { ConsentRequest } from '../services/oauth'

interface Props {
  user: AuthUser
  /** null while loading */
  request: ConsentRequest | null
  error: string | null
  onDecide: (approve: boolean) => Promise<void>
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** Where the user goes back to, named so they can tell a real app from an impostor. */
function destination(redirectUri: string): string {
  const { hostname, host } = new URL(redirectUri)
  return LOOPBACK_HOSTS.includes(hostname) ? `an app on this device (${host})` : host
}

export function AuthorizeConsent({ user, request, error, onDecide }: Props) {
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function decide(approve: boolean) {
    setSubmitError(null)
    setSubmitting(approve ? 'approve' : 'deny')
    try {
      await onDecide(approve)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong')
      setSubmitting(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        {error ? (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-1">Can't connect this app</h1>
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-6">
              {error}
            </p>
            <a href="/" className="text-sm text-indigo-600 hover:underline font-medium">
              Go to Expenser
            </a>
          </>
        ) : !request ? (
          <p className="text-sm text-gray-400 text-center py-6">Loading…</p>
        ) : (
          <>
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4">
              <Plug size={20} />
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-1">Connect {request.clientName}?</h1>
            <p className="text-sm text-gray-500 mb-4">
              {request.clientName} wants to use your Expenser account. It will be able to:
            </p>
            <ul className="text-sm text-gray-700 space-y-1.5 mb-4 list-disc pl-5">
              <li>See your expenses, categories and weekly allowance</li>
              <li>Add, change and delete expenses and categories</li>
              <li>Change your name and weekly allowance</li>
            </ul>
            <p className="text-xs text-gray-400 mb-6">
              Signed in as <span className="text-gray-600">{user.email}</span>. Afterwards you'll go
              back to <span className="font-medium text-gray-600">{destination(request.redirectUri)}</span>.
              You can disconnect it any time in Settings.
            </p>

            {submitError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-4">
                {submitError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => decide(false)}
                disabled={submitting !== null}
                className="flex-1 py-2 rounded-xl border border-gray-200 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {submitting === 'deny' ? 'Denying…' : 'Deny'}
              </button>
              <button
                type="button"
                onClick={() => decide(true)}
                disabled={submitting !== null}
                className="flex-1 py-2 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {submitting === 'approve' ? 'Connecting…' : 'Approve'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
