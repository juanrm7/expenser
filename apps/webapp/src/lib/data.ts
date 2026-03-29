export const BASE_ALLOWANCE = 100_000

export interface Category {
  name: string
  color: string
}

export interface AppConfig {
  baseAllowance: number
  categories: Category[]
}

export interface Expense {
  id: string
  amount: number
  category: string
  description: string
  date: string
}

export interface WeekData {
  weekStart: string
  carryOver: number
  expenses: Expense[]
}

export const DEFAULT_CATEGORIES: Category[] = [
  { name: 'Food', color: 'bg-emerald-100 text-emerald-700' },
  { name: 'Entertainment', color: 'bg-purple-100 text-purple-700' },
  { name: 'Others', color: 'bg-blue-100 text-blue-700' },
]

export const COLOR_PALETTE = [
  'bg-emerald-100 text-emerald-700',
  'bg-purple-100 text-purple-700',
  'bg-blue-100 text-blue-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-yellow-100 text-yellow-700',
  'bg-teal-100 text-teal-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
  'bg-violet-100 text-violet-700',
]

export function getMondayOf(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().split('T')[0]
}

export function loadConfig(): AppConfig {
  const stored = localStorage.getItem('expenser-config')
  if (!stored) return { baseAllowance: BASE_ALLOWANCE, categories: DEFAULT_CATEGORIES }
  return JSON.parse(stored)
}

export function saveConfig(config: AppConfig) {
  localStorage.setItem('expenser-config', JSON.stringify(config))
}

export function loadWeekData(baseAllowance: number): WeekData {
  const currentMonday = getMondayOf(new Date())
  const stored = localStorage.getItem('expenser-data')
  if (!stored) {
    return { weekStart: currentMonday, carryOver: 0, expenses: [] }
  }
  const data: WeekData = JSON.parse(stored)
  if (data.weekStart !== currentMonday) {
    const spent = data.expenses.reduce((sum, e) => sum + e.amount, 0)
    const prevBudget = baseAllowance + data.carryOver
    const newCarryOver = prevBudget - spent
    return { weekStart: currentMonday, carryOver: newCarryOver, expenses: [] }
  }
  return data
}

export function saveWeekData(data: WeekData) {
  localStorage.setItem('expenser-data', JSON.stringify(data))
}

export function formatARS(amount: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(amount)
}

export function randomColor(usedColors: string[]): string {
  const available = COLOR_PALETTE.filter(c => !usedColors.includes(c))
  const pool = available.length > 0 ? available : COLOR_PALETTE
  return pool[Math.floor(Math.random() * pool.length)]
}

export const HEX_COLOR_PALETTE = [
  '#10b981', '#8b5cf6', '#3b82f6', '#f97316',
  '#ec4899', '#eab308', '#14b8a6', '#f43f5e',
  '#06b6d4', '#7c3aed',
]

export function randomHexColor(usedColors: string[]): string {
  const available = HEX_COLOR_PALETTE.filter(c => !usedColors.includes(c))
  const pool = available.length > 0 ? available : HEX_COLOR_PALETTE
  return pool[Math.floor(Math.random() * pool.length)]
}
