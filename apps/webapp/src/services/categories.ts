import { env } from '../config/environment'

export interface Category {
  id: number
  name: string
  color: string
}

export async function getCategories(): Promise<Category[]> {
  const response = await fetch(`${env.backendUrl}/categories`)
  return response.json()
}

export async function createCategory(name: string, color: string): Promise<Category> {
  const response = await fetch(`${env.backendUrl}/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  })
  return response.json()
}

export async function deleteCategory(id: number): Promise<void> {
  await fetch(`${env.backendUrl}/categories/${id}`, { method: 'DELETE' })
}
