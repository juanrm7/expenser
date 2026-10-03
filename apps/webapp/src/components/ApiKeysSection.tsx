import { useState } from 'react'
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react'
import { createApiKey, revokeApiKey, type ApiKey, type CreatedApiKey } from '../services/apiKeys'

interface Props {
  apiKeys: ApiKey[]
  onApiKeyCreated: (apiKey: ApiKey) => void
  onApiKeyRevoked: (id: number) => void
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatLastUsed(iso: string | null): string {
  if (!iso) return 'Never used'
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'Used just now'
  if (minutes < 60) return `Used ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Used ${hours}h ago`
  return `Used ${formatDate(iso)}`
}

export function ApiKeysSection({ apiKeys, onApiKeyCreated, onApiKeyRevoked }: Props) {
  const [nameInput, setNameInput] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [newKey, setNewKey] = useState<CreatedApiKey | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleCreate(e: React.SyntheticEvent) {
    e.preventDefault()
    const name = nameInput.trim()
    if (!name) {
      setError('Give the key a name, e.g. "Laptop autofill"')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const created = await createApiKey(name)
      const { key: _key, ...summary } = created
      onApiKeyCreated(summary)
      setNewKey(created)
      setCopied(false)
      setNameInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevoke(apiKey: ApiKey) {
    if (!window.confirm(`Revoke "${apiKey.name}"? Anything using this key will stop working.`)) return
    try {
      await revokeApiKey(apiKey.id)
      onApiKeyRevoked(apiKey.id)
      if (newKey?.id === apiKey.id) setNewKey(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API key')
    }
  }

  async function copyNewKey() {
    if (!newKey) return
    try {
      await navigator.clipboard.writeText(newKey.key)
      setCopied(true)
    } catch {
      // Clipboard can be unavailable (e.g. insecure context) — the key is still selectable.
    }
  }

  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-800">API keys</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Let scripts like the autofill bot add expenses for you. Send the key as an{' '}
          <code className="text-gray-500">Authorization: Bearer</code> header.
        </p>
      </div>

      {newKey && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
          <p className="text-sm font-semibold text-amber-800">Copy your new key now</p>
          <p className="text-xs text-amber-700">
            This is the only time it will be shown. If you lose it, revoke it and create another.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all rounded-lg bg-white border border-amber-200 px-3 py-2 text-xs text-gray-800 select-all">
              {newKey.key}
            </code>
            <button
              type="button"
              onClick={copyNewKey}
              className="shrink-0 p-2 rounded-lg text-amber-700 hover:bg-amber-100 transition-colors"
              aria-label="Copy API key"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setNewKey(null)}
            className="text-xs font-medium text-amber-800 hover:underline"
          >
            I've saved it
          </button>
        </div>
      )}

      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          type="text"
          value={nameInput}
          onChange={(e) => {
            setNameInput(e.target.value)
            setError('')
          }}
          placeholder="Key name, e.g. Laptop autofill"
          maxLength={50}
          className="flex-1 min-w-0 border border-gray-200 rounded-xl px-4 py-3 text-base sm:text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
        <button
          type="submit"
          disabled={submitting}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 rounded-xl transition-colors"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </form>
      {error && <p className="text-red-500 text-xs">{error}</p>}

      <ul className="space-y-2">
        {apiKeys.map((apiKey) => (
          <li key={apiKey.id} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <KeyRound size={16} className="text-gray-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{apiKey.name}</p>
                <p className="text-xs text-gray-400">
                  <code>{apiKey.prefix}…</code> · {formatLastUsed(apiKey.lastUsedAt)}
                </p>
                <p className="text-xs text-gray-400">Created {formatDate(apiKey.createdAt)}</p>
              </div>
            </div>
            <button
              onClick={() => handleRevoke(apiKey)}
              className="shrink-0 p-1.5 text-gray-300 hover:text-red-400 transition-colors rounded-lg hover:bg-red-50"
              aria-label={`Revoke ${apiKey.name}`}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
        {apiKeys.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-2">No API keys yet.</p>
        )}
      </ul>
    </section>
  )
}
