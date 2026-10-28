/**
 * OAuth login flow for CodeBuddy CLI.
 *
 * The flow is a polling login (no callback redirect):
 * 1. POST /v2/plugin/auth/state → returns a `state` and an `authUrl`.
 * 2. The user opens `authUrl` in their browser and signs in.
 * 3. The host polls GET /v2/plugin/auth/token?state=... every few seconds
 *    until it returns an `accessToken` (code 0) or times out.
 *
 * This mirrors the flow in `dsh-router-codebuddy` and the official CLI,
 * adapted to this plugin's header conventions (X-IDE-* family, identity
 * resolution, and the common-header builder from upstream.ts).
 *
 * @module dsh-codebuddy-cli/oauth
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { CodeBuddyClientIdentity } from './client-identity.ts'
import { clientIdentityHeaders } from './client-identity.ts'

/**
 * Deployments the sign-in flow can target.
 *
 * Both expose the same `/v2/plugin/auth/*` surface — verified against the live
 * gateways: `state` returns a `state` + `authUrl` on each host, and `token`
 * answers `11217 login ing…` while the browser half is still pending. What
 * differs is only the host, and the account a user signs into there:
 *
 * - `cn` — the China site, whose API host is `copilot.tencent.com`;
 * - `global` — WorkBuddy (`www.workbuddy.ai`), the international site this
 *   plugin also serves chat and billing from.
 *
 * `www.codebuddy.ai` (the CodeBuddy international site) is a third deployment.
 * Its `state` endpoint answers too, but its chat plane rejects this plugin's
 * requests (`11128 request illegal`) and its catalog paths 404, so signing in
 * there would produce an account that cannot be served.
 */
export type OAuthRegion = 'cn' | 'global'

/** Host that serves each region's sign-in and token endpoints. */
const OAUTH_BASE: Readonly<Record<OAuthRegion, string>> = {
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
}

/** The region narrowed from untrusted input; undefined when it names neither. */
export function parseOAuthRegion(value: unknown): OAuthRegion | undefined {
  if (value === 'cn' || value === 'global') return value
  return undefined
}

/** Account info endpoint path (called after a token is obtained). */
const ACCOUNT_PATH = '/v2/plugin/auth/login/account'

/** Upstream "pending" code — keep polling. */
const PENDING_CODE = 11217

/** Request timeout for individual OAuth HTTP calls. */
const REQUEST_TIMEOUT_MS = 20_000

/** A credential captured from a successful OAuth login. */
export interface OAuthLoginResult {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  uid: string
  nickname?: string
  domain: string
  enterpriseId?: string
}

/** Headers for the state and token endpoints (no Authorization, identity only). */
function oauthHeaders(identity: CodeBuddyClientIdentity, region: OAuthRegion): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Product': 'SaaS',
    // The host the sign-in runs against, not a constant: the global gateway
    // scopes the flow to its own domain.
    'X-Domain': new URL(OAUTH_BASE[region]).hostname,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    ...clientIdentityHeaders(identity),
  }
}

/** Read and parse a JSON envelope from a fetch response. */
async function readEnvelope(response: Response): Promise<{ code: number; msg: string; data: Record<string, unknown> }> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`codebuddy oauth returned non-JSON (http ${response.status}): ${text.slice(0, 200)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`codebuddy oauth returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: typeof document['data'] === 'object' && document['data'] !== null
      ? document['data'] as Record<string, unknown>
      : {},
  }
}

/** Parse an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Start the OAuth login: request a `state` and `authUrl` from the upstream.
 *
 * @param identity - resolved client identity for request headers.
 * @returns the `authUrl` the user should open, and the internal `state`.
 */
export async function startOAuthLogin(
  identity: CodeBuddyClientIdentity,
  region: OAuthRegion = 'cn',
): Promise<{ authUrl: string; state: string }> {
  const response = await fetch(`${OAUTH_BASE[region]}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: oauthHeaders(identity, region),
    body: '{}',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`codebuddy login state failed (http ${response.status}): ${envelope.msg}`)
  }
  const state = optionalString(envelope.data['state'])
  const authUrl = optionalString(envelope.data['authUrl']) ?? optionalString(envelope.data['auth_url'])
  if (state === undefined || authUrl === undefined) {
    throw new Error(`codebuddy login state returned no authUrl: ${envelope.msg}`)
  }
  return { authUrl, state }
}

/**
 * Poll the token endpoint once. Returns the result if the login completed
 * (code 0 + accessToken), undefined if still pending, or throws on a
 * terminal failure.
 *
 * @param state - the state from {@link startOAuthLogin}.
 * @param identity - resolved client identity for request headers.
 * @param region - the same region {@link startOAuthLogin} was called with; the
 *   `state` is only meaningful on the host that minted it.
 */
export async function pollOAuthLogin(
  state: string,
  identity: CodeBuddyClientIdentity,
  region: OAuthRegion = 'cn',
): Promise<OAuthLoginResult | undefined> {
  const base = OAUTH_BASE[region]
  const response = await fetch(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    method: 'GET',
    headers: oauthHeaders(identity, region),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const envelope = await readEnvelope(response)
  // Pending: keep polling.
  if (envelope.code === PENDING_CODE) return undefined
  if (envelope.code !== 0) {
    throw new Error(`codebuddy login failed (code ${envelope.code}): ${envelope.msg}`)
  }
  const accessToken = optionalString(envelope.data['accessToken']) ?? optionalString(envelope.data['access_token'])
  if (accessToken === undefined) {
    throw new Error(`codebuddy login returned no accessToken: ${envelope.msg}`)
  }
  const refreshToken = optionalString(envelope.data['refreshToken']) ?? optionalString(envelope.data['refresh_token']) ?? ''
  const expiresIn = typeof envelope.data['expiresIn'] === 'number' ? envelope.data['expiresIn'] as number : 86400
  const expiresAtMs = typeof envelope.data['expiresAt'] === 'number'
    ? expiryToMs(envelope.data['expiresAt'] as number)
    : Date.now() + expiresIn * 1000
  const refreshExpiresAtMs = typeof envelope.data['refreshExpiresAt'] === 'number'
    ? expiryToMs(envelope.data['refreshExpiresAt'] as number)
    : undefined
  // The account's home domain decides which upstream serves it later (a
  // `workbuddy.ai` account must never be routed to the CN gateway), so an
  // answer that omits it falls back to the host that just minted the token
  // rather than to the empty string, which `regionOf` reads as CN.
  const domain = optionalString(envelope.data['domain']) ?? new URL(base).hostname

  // Fetch account info (uid, nickname, enterpriseId).
  let uid = ''
  let nickname: string | undefined
  let enterpriseId: string | undefined
  try {
    const accountHeaders: Record<string, string> = {
      ...oauthHeaders(identity, region),
      'Authorization': `Bearer ${accessToken}`,
    }
    if (domain !== '') {
      accountHeaders['X-Domain'] = domain
      delete accountHeaders['X-No-Department-Info']
    }
    const accResponse = await fetch(`${base}${ACCOUNT_PATH}?state=${encodeURIComponent(state)}`, {
      method: 'GET',
      headers: accountHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (accResponse.ok) {
      const accEnvelope = await readEnvelope(accResponse)
      if (accEnvelope.code === 0) {
        uid = optionalString(accEnvelope.data['uid']) ?? ''
        nickname = optionalString(accEnvelope.data['nickname'])
        enterpriseId = optionalString(accEnvelope.data['enterpriseId'])
      }
    }
  } catch {
    // Account info is best-effort; the token is already valid.
  }

  // Fall back to the access token's JWT payload when the account-info call
  // returns nothing usable. The CodeBuddy access token is a JWT whose payload
  // carries `sub` (the account uid), `nickname` and `preferred_username`, so
  // the card can still show a meaningful identity even if the profile endpoint
  // is unavailable or returns an unexpected shape.
  if (uid === '' || nickname === undefined) {
    const claims = parseJwtClaims(accessToken)
    if (uid === '' && typeof claims['sub'] === 'string') uid = claims['sub']
    if (nickname === undefined) {
      const candidate = typeof claims['nickname'] === 'string' ? claims['nickname'] : undefined
      nickname = candidate ?? (typeof claims['preferred_username'] === 'string' ? claims['preferred_username'] : undefined)
    }
    if (enterpriseId === undefined && typeof claims['enterprise_id'] === 'string' && claims['enterprise_id'] !== '') {
      enterpriseId = claims['enterprise_id']
    }
  }

  return {
    accessToken,
    refreshToken,
    expiresAtMs,
    ...refreshExpiresAtMs !== undefined ? { refreshExpiresAtMs } : {},
    uid,
    ...nickname !== undefined ? { nickname } : {},
    domain,
    ...enterpriseId !== undefined ? { enterpriseId } : {},
  }
}

/**
 * Decode the claims of a JWT without verifying the signature.
 *
 * The token material never crosses to the browser and the claims are only
 * used for display identity (uid / nickname), so signature verification is
 * not needed here. Any parse failure yields an empty object.
 */
function parseJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2) return {}
  const payload = parts[1]
  if (payload === undefined) return {}
  let json: string
  try {
    const padded = payload.replace(/-/gu, '+').replace(/_/gu, '/')
    json = Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** Generate a stable client-side account id. */
export function generateAccountId(): string {
  return randomUUID()
}
