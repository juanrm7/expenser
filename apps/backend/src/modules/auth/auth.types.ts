export type Role = 'user' | 'admin'

export interface SignupRequest {
  name: string
  email: string
  password: string
  expendableAmountPerWeek: number
}

export interface LoginRequest {
  email: string
  password: string
}

export interface UpdateProfileRequest {
  name?: string
  expendableAmountPerWeek?: number
}

export interface SessionUser {
  id: number
  name: string
  email: string
  expendableAmountPerWeek: number
  role: Role
}

export interface AuthResult {
  user: SessionUser
  sessionId: string
  expiresAt: Date
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
