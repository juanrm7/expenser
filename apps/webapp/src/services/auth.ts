import { env } from '../config/environment'

export interface AuthUser {
  id: number
  name: string
  email: string
  expendableAmountPerWeek: number
  role: 'user' | 'admin'
}

export interface SignupPayload {
  name: string
  email: string
  password: string
  expendableAmountPerWeek: number
}

export interface LoginPayload {
  email: string
  password: string
}

export interface UpdateProfilePayload {
  name?: string
  expendableAmountPerWeek?: number
}

async function parseError(response: Response): Promise<string> {
  try {
    const data = await response.json()
    if (data && typeof data.message === 'string') return data.message
  } catch {
    // ignore
  }
  return 'Request failed'
}

export async function signup(payload: SignupPayload): Promise<AuthUser> {
  const response = await fetch(`${env.backendUrl}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function login(payload: LoginPayload): Promise<AuthUser> {
  const response = await fetch(`${env.backendUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function logout(): Promise<void> {
  await fetch(`${env.backendUrl}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  })
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch(`${env.backendUrl}/auth/me`, {
    credentials: 'include',
  })
  if (response.status === 401) return null
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function updateProfile(payload: UpdateProfilePayload): Promise<AuthUser> {
  const response = await fetch(`${env.backendUrl}/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}
