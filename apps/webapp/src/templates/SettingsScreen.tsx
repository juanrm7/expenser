import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { AppConfig } from '../lib/data'
import { formatARS, randomColor } from '../lib/data'

interface Props {
  config: AppConfig
  onChange: (config: AppConfig) => void
}

export function SettingsScreen({ config, onChange }: Props) {
  const [allowanceInput, setAllowanceInput] = useState(String(config.baseAllowance))
  const [allowanceSaved, setAllowanceSaved] = useState(false)
  const [categoryInput, setCategoryInput] = useState('')
  const [categoryError, setCategoryError] = useState('')

  function saveAllowance(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const val = parseFloat(allowanceInput.replace(',', '.'))
    if (!val || val <= 0) return
    onChange({ ...config, baseAllowance: val })
    setAllowanceSaved(true)
    setTimeout(() => setAllowanceSaved(false), 2000)
  }

  function addCategory(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = categoryInput.trim()
    if (!name) return
    if (config.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      setCategoryError('Category already exists')
      return
    }
    setCategoryError('')
    const color = randomColor(config.categories.map(c => c.color))
    onChange({ ...config, categories: [...config.categories, { name, color }] })
    setCategoryInput('')
  }

  function removeCategory(name: string) {
    onChange({ ...config, categories: config.categories.filter(c => c.name !== name) })
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-6">

      {/* Allowance */}
      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
        <div>
          <h2 className="font-semibold text-gray-800">Weekly allowance</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Carry-over from previous weeks is applied on top of this amount.
          </p>
        </div>
        <form onSubmit={saveAllowance} className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={allowanceInput}
            onChange={e => setAllowanceInput(e.target.value)}
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            placeholder="Amount in ARS"
          />
          <button
            type="submit"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 rounded-xl transition-colors"
          >
            {allowanceSaved ? 'Saved!' : 'Save'}
          </button>
        </form>
        <p className="text-xs text-gray-400">
          Current: <span className="font-medium text-gray-600">{formatARS(config.baseAllowance)}</span> / week
        </p>
      </section>

      {/* Categories */}
      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-gray-800">Categories</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Colors are assigned automatically.
          </p>
        </div>

        <form onSubmit={addCategory} className="flex gap-2">
          <input
            type="text"
            value={categoryInput}
            onChange={e => { setCategoryInput(e.target.value); setCategoryError('') }}
            placeholder="New category name"
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <button
            type="submit"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 rounded-xl transition-colors"
          >
            Add
          </button>
        </form>
        {categoryError && <p className="text-red-500 text-xs">{categoryError}</p>}

        <ul className="space-y-2">
          {config.categories.map(cat => (
            <li key={cat.name} className="flex items-center justify-between">
              <span className={`text-xs font-medium px-3 py-1.5 rounded-lg ${cat.color}`}>
                {cat.name}
              </span>
              <button
                onClick={() => removeCategory(cat.name)}
                className="p-1.5 text-gray-300 hover:text-red-400 transition-colors rounded-lg hover:bg-red-50"
                aria-label={`Remove ${cat.name}`}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
          {config.categories.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-2">No categories yet.</p>
          )}
        </ul>
      </section>

    </div>
  )
}
