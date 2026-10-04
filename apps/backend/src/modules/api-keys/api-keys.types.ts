export interface ApiKeySummary {
  id: number
  name: string
  prefix: string
  lastUsedAt: Date | null
  createdAt: Date
}

/** Returned once, on creation — the only time the full key is ever available */
export interface CreatedApiKey extends ApiKeySummary {
  key: string
}

export interface CreateApiKeyBody {
  name: string
}

export class ApiKeyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
