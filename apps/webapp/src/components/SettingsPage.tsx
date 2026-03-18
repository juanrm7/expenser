import { useState, useEffect } from 'react'
import type { AppConfig } from '../lib/data'
import { loadConfig, saveConfig } from '../lib/data'
import Header from './Header'
import SettingsScreen from './SettingsScreen'

export default function SettingsPage() {
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
      <Header page="settings" />
      <SettingsScreen config={config} onChange={handleConfigChange} />
    </div>
  )
}
