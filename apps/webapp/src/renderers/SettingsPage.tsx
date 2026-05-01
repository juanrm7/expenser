import { useState, useEffect } from 'react'
import { Header } from '../components/Header'
import { SettingsScreen } from '../templates/SettingsScreen'
import { getCategories, type Category } from '../services/categories'
import { useAuth } from '../lib/useAuth'
import type { AuthUser } from '../services/auth'

export function SettingsPage() {
  const { user, loading } = useAuth()
  const [categories, setCategories] = useState<Category[]>([])
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    if (!user) return
    setCurrentUser(user)
    async function fetchCategories() {
      const data = await getCategories()
      setCategories(data)
    }
    fetchCategories()
  }, [user])

  if (loading || !currentUser) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Header page="settings" user={currentUser} />
      <SettingsScreen
        user={currentUser}
        onUserChange={setCurrentUser}
        categories={categories}
        onCategoryAdded={(cat) => setCategories((prev) => [...prev, cat])}
        onCategoryRemoved={(id) => setCategories((prev) => prev.filter((c) => c.id !== id))}
      />
    </div>
  )
}
