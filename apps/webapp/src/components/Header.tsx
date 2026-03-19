import { Home, Settings } from 'lucide-react'

interface Props {
  page: 'home' | 'settings'
}

export function Header({ page }: Props) {
  return (
    <header className="flex items-center justify-between px-4 py-4 bg-white border-b border-gray-100 sticky top-0 z-10">
      <h1 className="text-lg font-bold text-gray-900 tracking-tight">Expenser</h1>
      <a
        href={page === 'home' ? '/settings' : '/'}
        className="p-2 rounded-xl text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
        aria-label={page === 'home' ? 'Go to settings' : 'Go to home'}
      >
        {page === 'home' ? <Settings size={20} /> : <Home size={20} />}
      </a>
    </header>
  )
}
