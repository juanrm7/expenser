import { useState } from 'react'
import { Check, Copy, Plug, Unplug } from 'lucide-react'
import { env } from '../config/environment'
import { instantLabel, lastUsedLabel } from '../lib/dates'
import { disconnect, type Connection } from '../services/oauth'

interface Props {
  connections: Connection[]
  onDisconnected: (id: number) => void
}

export function ConnectedAppsSection({ connections, onDisconnected }: Props) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const mcpUrl = `${env.backendUrl}/mcp`

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(mcpUrl)
      setCopied(true)
    } catch {
      // Clipboard can be unavailable (e.g. insecure context) — the URL is still selectable.
    }
  }

  async function handleDisconnect(connection: Connection) {
    if (!window.confirm(`Disconnect ${connection.clientName}? It will lose access to your account.`)) return
    try {
      await disconnect(connection.id)
      onDisconnected(connection.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }

  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-800">Connected apps</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Let Claude read and manage your expenses: in Claude, go to Customize → Connectors → Add
          custom connector, and enter this URL. If it asks how to register, choose to register
          automatically.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-800 select-all">
          {mcpUrl}
        </code>
        <button
          type="button"
          onClick={copyUrl}
          className="shrink-0 p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
          aria-label="Copy connector URL"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {error && <p className="text-red-500 text-xs">{error}</p>}

      <ul className="space-y-2">
        {connections.map((connection) => (
          <li key={connection.id} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Plug size={16} className="text-gray-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{connection.clientName}</p>
                <p className="text-xs text-gray-400">
                  Connected {instantLabel(connection.createdAt)} · {lastUsedLabel(connection.lastUsedAt)}
                </p>
              </div>
            </div>
            <button
              onClick={() => handleDisconnect(connection)}
              className="shrink-0 p-1.5 text-gray-300 hover:text-red-400 transition-colors rounded-lg hover:bg-red-50"
              aria-label={`Disconnect ${connection.clientName}`}
            >
              <Unplug size={15} />
            </button>
          </li>
        ))}
        {connections.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-2">No apps connected yet.</p>
        )}
      </ul>
    </section>
  )
}
