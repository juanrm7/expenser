import { useState, useEffect } from 'react'
import type { AppConfig } from '../lib/data'
import { loadConfig, saveConfig } from '../lib/data'
import Header from './Header'
import ExpenseTracker from './ExpenseTracker'
import SettingsScreen from './SettingsScreen'

export default function App() {
  const [view, setView] = useState<'home' | 'settings'>('home')
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    setConfig(loadConfig())
  }, [])

  if (!config) return null

  function handleConfigChange(updated: AppConfig) {
    setConfig(updated)
    saveConfig(updated)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header view={view} onToggle={() => setView(v => v === 'home' ? 'settings' : 'home')} />
      {view === 'home'
        ? <ExpenseTracker config={config} />
        : <SettingsScreen config={config} onChange={handleConfigChange} />
      }
    </div>
  )
}
