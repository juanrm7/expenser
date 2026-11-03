// Random secrets (API keys, OAuth codes and tokens) and the hashes they're stored and looked up by.
//
// Secrets are 256 random bits, so a fast hash (SHA-256) is enough, and unlike a salted one it lets a
// secret be found by its hash. The secret itself is only ever shown to whoever it's issued to.

import { createHash, randomBytes } from 'node:crypto'

/** A new secret: `prefix` followed by 32 random bytes, base64url-encoded. */
export function generateToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url')
}

/** The hex SHA-256 of a secret, as stored. */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
