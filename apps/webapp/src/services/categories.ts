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
