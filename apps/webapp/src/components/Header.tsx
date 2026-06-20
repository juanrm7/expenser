import { Home, LogOut, Settings } from 'lucide-react'
import { logout } from '../services/auth'
import type { AuthUser } from '../services/auth'
import { clearCache } from '../lib/cache'

interface Props {
  page: 'home' | 'settings'
  user: AuthUser
}

export function Header({ page, user }: Props) {
  async function handleLogout() {
    try {
      await logout()
    } finally {
      clearCache()
      window.location.href = '/login'
    }
  }

  return (
    <header className="flex items-center justify-between px-4 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
      <h1 className="text-lg font-bold text-gray-900 tracking-tight">Expenser</h1>
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600 hidden sm:inline">Hi, {user.name}</span>
        <a
          href={page === 'home' ? '/settings' : '/'}
          className="p-2 rounded-xl text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
          aria-label={page === 'home' ? 'Go to settings' : 'Go to home'}
        >
          {page === 'home' ? <Settings size={20} /> : <Home size={20} />}
        </a>
        <button
          type="button"
          onClick={handleLogout}
          className="p-2 rounded-xl text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors"
          aria-label="Log out"
        >
          <LogOut size={20} />
        </button>
      </div>
    </header>
  )
}
