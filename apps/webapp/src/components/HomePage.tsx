import { useState, useEffect } from 'react'
import type { AppConfig } from '../lib/data'
import { loadConfig } from '../lib/data'
import Header from './Header'
import ExpenseTracker from './ExpenseTracker'

export default function HomePage() {
  const [config, setConfig] = useState<AppConfig | null>(null)

  useEffect(() => {
    setConfig(loadConfig())
  }, [])

  if (!config) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Header page="home" />
      <ExpenseTracker config={config} />
    </div>
  )
}
