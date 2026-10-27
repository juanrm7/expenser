-- OAuth for the MCP server, so the Claude apps can connect: clients that registered themselves
-- (RFC 7591), short-lived authorization codes, and grants. A grant is one user's connection to one
-- client, holding the hashes of its current access and refresh tokens; revoking it deletes the row.

CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    -- A JSON array of the URIs codes may be sent to.
    "redirectUris" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);

CREATE TABLE "OAuthCode" (
    "codeHash" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "redirectUri" TEXT NOT NULL,
    -- PKCE: base64url(SHA-256(code_verifier)).
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OAuthGrant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "accessTokenHash" TEXT NOT NULL,
    "accessExpiresAt" DATETIME NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "refreshExpiresAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OAuthGrant_accessTokenHash_key" ON "OAuthGrant"("accessTokenHash");
CREATE UNIQUE INDEX "OAuthGrant_refreshTokenHash_key" ON "OAuthGrant"("refreshTokenHash");
CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");
