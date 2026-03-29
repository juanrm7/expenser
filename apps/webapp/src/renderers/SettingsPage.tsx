import { useState, useEffect } from 'react'
import type { AppConfig } from '../lib/data'
import { loadConfig, saveConfig } from '../lib/data'
import { Header } from '../components/Header'
import { SettingsScreen } from '../templates/SettingsScreen'
import { getCategories, type Category } from '../services/categories'

export function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    setConfig(loadConfig())
    async function fetchCategories() {
      const data = await getCategories()
      setCategories(data)
    }
    fetchCategories()
  }, [])

  if (!config) return null

  function handleConfigChange(updated: AppConfig) {
    setConfig(updated)
    saveConfig(updated)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header page="settings" />
      <SettingsScreen
        config={config}
        onChange={handleConfigChange}
        categories={categories}
        onCategoryAdded={cat => setCategories(prev => [...prev, cat])}
        onCategoryRemoved={id => setCategories(prev => prev.filter(c => c.id !== id))}
      />
    </div>
  )
}
