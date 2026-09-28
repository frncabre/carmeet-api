import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const defaultEnvPath = process.env.MELI_ENV_FILE || path.join(root, '.env')
const oauthEndpoint = 'https://api.mercadolibre.com/oauth/token'
const authorizationEndpoint = 'https://auth.mercadolibre.com.ar/authorization'

export function parseEnv(source) {
  const values = {}
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const raw = match[2].trim()
    values[match[1]] = raw.length >= 2 && ((raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'"))
      ? raw.slice(1, -1)
      : raw
  }
  return values
}

export async function readConfig(envPath = defaultEnvPath) {
  const source = await fs.readFile(envPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const values = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MELI_'))), ...parseEnv(source) }
  return { envPath, source, values }
}

function requireValue(values, key) {
  const value = values[key]?.trim()
  if (!value) throw new Error(`Falta ${key} en la configuración de carmeet-api.`)
  return value
}

function redirectUri(values) {
  const value = values.MELI_REDIRECT_URI || values.MELI_URL
  if (!value) throw new Error('Falta MELI_REDIRECT_URI o MELI_URL en la configuración de carmeet-api.')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('La URL de retorno debe usar HTTP o HTTPS.')
  return value
}

export function authorizationUrl(values, state, verifier) {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', requireValue(values, 'MELI_CLIENT_ID'))
  url.searchParams.set('redirect_uri', redirectUri(values))
  url.searchParams.set('state', state)
  if (verifier) {
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

export async function postToken(fields, fetchImpl = fetch) {
  const response = await fetchImpl(oauthEndpoint, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = typeof data.error === 'string' ? data.error : 'oauth_error'
    throw new Error(`Mercado Libre rechazó el intercambio (${response.status}, ${code}).`)
  }
  if (typeof data.access_token !== 'string' || !data.access_token || (!Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0)) {
    throw new Error('Mercado Libre devolvió una respuesta de token incompleta.')
  }
  return data
}

function envValue(value) {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value)
}

export function updateEnv(source, updates) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.replace(/\r?\n$/, '').split(/\r?\n/)
  const seen = new Set()
  const next = lines.map(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!match || !(match[1] in updates)) return line
    seen.add(match[1])
    return `${match[1]}=${envValue(String(updates[match[1]]))}`
  })
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${envValue(String(value))}`)
  }
  return next.join(newline) + newline
}

async function atomicWrite(target, contents) {
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function withLock(envPath, action) {
  const lockPath = path.join(path.dirname(envPath), '.meli-oauth.lock')
  let handle
  try {
    handle = await fs.open(lockPath, 'wx', 0o600)
    await handle.writeFile(`${process.pid}\n`)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Ya hay otro proceso OAuth en ejecución (archivo .meli-oauth.lock).')
    throw error
  }
  try {
    return await action()
  } finally {
    await handle.close()
    await fs.rm(lockPath, { force: true })
  }
}

export async function saveTokenResponse(envPath, token, { consumeCode = false, now = Date.now() } = {}) {
  const { source } = await readConfig(envPath)
  const updates = {
    MELI_ACCESS_TOKEN: token.access_token,
    MELI_EXPIRES_AT: new Date(now + Number(token.expires_in) * 1000).toISOString(),
    MELI_REFRESH_TOKEN: typeof token.refresh_token === 'string' ? token.refresh_token : '',
  }
  if (consumeCode) updates.MELI_CODE = ''
  await atomicWrite(envPath, updateEnv(source, updates))
  return { expiresAt: updates.MELI_EXPIRES_AT, hasRefresh: Boolean(updates.MELI_REFRESH_TOKEN) }
}

function callbackCode(callback, expectedState, expectedRedirect) {
  const url = new URL(callback)
  if (`${url.origin}${url.pathname}` !== new URL(expectedRedirect).origin + new URL(expectedRedirect).pathname) {
    throw new Error('La URL recibida no coincide con MELI_REDIRECT_URI.')
  }
  if (expectedState && url.searchParams.get('state') !== expectedState) {
    throw new Error('El parámetro state no coincide con la autorización iniciada.')
  }
  const code = url.searchParams.get('code')
  if (!code) throw new Error('La URL recibida no tiene code.')
  return code
}

export async function exchangeCode(envPath = defaultEnvPath, callback, fetchImpl = fetch) {
  return withLock(envPath, async () => {
    const { values } = await readConfig(envPath)
    const pendingPath = path.join(path.dirname(envPath), '.meli-auth-pending.json')
    const pending = await fs.readFile(pendingPath, 'utf8').then(JSON.parse).catch(() => null)
    if (pending && (!Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > 600000)) throw new Error('La autorización pendiente venció. Iniciá una nueva.')
    if (callback && !pending) throw new Error('No hay una autorización pendiente para validar state.')
    if (pending && !callback) {
      throw new Error('Esta autorización usa state: ejecutá exchange --callback con la URL completa de retorno.')
    }
    const code = callback
      ? callbackCode(callback, pending?.state, redirectUri(values))
      : requireValue(values, 'MELI_CODE')
    const fields = {
      grant_type: 'authorization_code',
      client_id: requireValue(values, 'MELI_CLIENT_ID'),
      client_secret: requireValue(values, 'MELI_CLIENT_SECRET'),
      code,
      redirect_uri: redirectUri(values),
    }
    const verifier = pending?.verifier || values.MELI_CODE_VERIFIER
    if (verifier) fields.code_verifier = verifier
    const token = await postToken(fields, fetchImpl)
    const saved = await saveTokenResponse(envPath, token, { consumeCode: true })
    await fs.rm(pendingPath, { force: true })
    return saved
  })
}

export async function refreshToken(envPath = defaultEnvPath, fetchImpl = fetch) {
  return withLock(envPath, async () => {
    const { values } = await readConfig(envPath)
    const token = await postToken({
      grant_type: 'refresh_token',
      client_id: requireValue(values, 'MELI_CLIENT_ID'),
      client_secret: requireValue(values, 'MELI_CLIENT_SECRET'),
      refresh_token: requireValue(values, 'MELI_REFRESH_TOKEN'),
    }, fetchImpl)
    return saveTokenResponse(envPath, token)
  })
}

export async function startAuthorization(envPath = defaultEnvPath) {
  return withLock(envPath, async () => {
  const { values } = await readConfig(envPath)
  const state = randomBytes(24).toString('base64url')
  const verifier = values.MELI_PKCE === 'true' ? randomBytes(48).toString('base64url') : undefined
  const url = authorizationUrl(values, state, verifier)
  const pendingPath = path.join(path.dirname(envPath), '.meli-auth-pending.json')
  await atomicWrite(pendingPath, JSON.stringify({ state, verifier, createdAt: Date.now() }))
  return { url }
  })
}

