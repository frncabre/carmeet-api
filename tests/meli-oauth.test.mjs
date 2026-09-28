import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  authorizationUrl,
  exchangeCode,
  parseEnv,
  refreshToken,
  startAuthorization,
  updateEnv,
} from '../src/services/meli-oauth.mjs'

test('authorization callback validates state, exchanges PKCE code and prevents replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-callback-test-'))
  const envPath = path.join(directory, '.env')
  await writeFile(envPath, 'MELI_CLIENT_ID=123\nMELI_CLIENT_SECRET=secret\nMELI_URL=https://example.com/callback\nMELI_PKCE=true\n')
  const { url } = await startAuthorization(envPath)
  const authorization = new URL(url)
  const callback = `https://example.com/callback?code=code&state=${authorization.searchParams.get('state')}`
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  const result = await exchangeCode(envPath, callback, async (_url, options) => {
    assert.ok(options.body.get('code_verifier'))
    assert.equal(options.body.get('code'), 'code')
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 21600 })
  })
  assert.equal(result.hasRefresh, true)
  await assert.rejects(exchangeCode(envPath, callback, () => { throw new Error('must not fetch') }), /No hay una autorización pendiente/)
})

test('expired authorization never exchanges its code', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-expired-test-'))
  const envPath = path.join(directory, '.env')
  await writeFile(envPath, 'MELI_CLIENT_ID=123\nMELI_CLIENT_SECRET=secret\nMELI_URL=https://example.com/callback\n')
  await writeFile(path.join(directory, '.meli-auth-pending.json'), JSON.stringify({ state: 'expected', createdAt: Date.now() - 601000 }))
  await assert.rejects(exchangeCode(envPath, 'https://example.com/callback?code=unused&state=expected', () => { throw new Error('must not fetch') }), /pendiente venció/)
})

test('quoted redirect URL and OAuth URL use exact callback and state', () => {
  const values = parseEnv('MELI_CLIENT_ID=123\nMELI_URL="https://example.com/callback"\n')
  const url = new URL(authorizationUrl(values, 'random-state'))
  assert.equal(url.searchParams.get('client_id'), '123')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/callback')
  assert.equal(url.searchParams.get('state'), 'random-state')
  const pkceUrl = new URL(authorizationUrl(values, 'random-state', 'verifier-value'))
  assert.equal(pkceUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(pkceUrl.searchParams.get('code_challenge'))
  assert.equal(updateEnv('A=1\r\nB=2\r\n', { B: '3' }), 'A=1\r\nB=3\r\n')
})

test('exchange and refresh rotate credentials without printing or losing unrelated env values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-meli-test-'))
  const envPath = path.join(directory, '.env')
  await writeFile(envPath, 'MELI_CLIENT_ID=123\nMELI_CLIENT_SECRET=secret\nMELI_URL="https://example.com/callback"\nMELI_CODE=first-code\nOTHER=keep\n')
  const bodies = []
  const responses = [
    { access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 21600 },
    { access_token: 'access-two', refresh_token: 'refresh-two', expires_in: 21600 },
  ]
  const fetchImpl = async (_url, options) => {
    bodies.push(new URLSearchParams(options.body))
    return new Response(JSON.stringify(responses.shift()), { status: 200 })
  }
  try {
    assert.equal((await exchangeCode(envPath, undefined, fetchImpl)).hasRefresh, true)
    assert.equal(bodies[0].get('grant_type'), 'authorization_code')
    assert.equal(bodies[0].get('redirect_uri'), 'https://example.com/callback')
    assert.equal(bodies[0].get('code'), 'first-code')
    assert.equal((await refreshToken(envPath, fetchImpl)).hasRefresh, true)
    assert.equal(bodies[1].get('grant_type'), 'refresh_token')
    assert.equal(bodies[1].get('refresh_token'), 'refresh-one')
    const saved = parseEnv(await readFile(envPath, 'utf8'))
    assert.equal(saved.MELI_ACCESS_TOKEN, 'access-two')
    assert.equal(saved.MELI_REFRESH_TOKEN, 'refresh-two')
    assert.equal(saved.MELI_CODE, '')
    assert.equal(saved.OTHER, 'keep')
    assert.ok(Number.isFinite(Date.parse(saved.MELI_EXPIRES_AT)))
  } finally {
    await rm(envPath, { force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('OAuth failures do not change stored credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-meli-test-'))
  const envPath = path.join(directory, '.env')
  const original = 'MELI_CLIENT_ID=123\nMELI_CLIENT_SECRET=secret\nMELI_REFRESH_TOKEN=old-refresh\n'
  await writeFile(envPath, original)
  try {
    await assert.rejects(refreshToken(envPath, async () => new Response('{"error":"invalid_grant"}', { status: 400 })), /invalid_grant/)
    assert.equal(await readFile(envPath, 'utf8'), original)
  } finally {
    await rm(envPath, { force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('callback with the wrong state cannot consume an authorization code', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-meli-test-'))
  const envPath = path.join(directory, '.env')
  const pendingPath = path.join(directory, '.meli-auth-pending.json')
  await writeFile(envPath, 'MELI_CLIENT_ID=123\nMELI_CLIENT_SECRET=secret\nMELI_URL=https://example.com/callback\n')
  await writeFile(pendingPath, JSON.stringify({ state: 'expected', createdAt: Date.now() }))
  try {
    await assert.rejects(
      exchangeCode(envPath, 'https://example.com/callback?code=unused&state=wrong', () => { throw new Error('unexpected fetch') }),
      /state no coincide/,
    )
    assert.ok(await readFile(pendingPath, 'utf8'))
  } finally {
    await rm(pendingPath, { force: true })
    await rm(envPath, { force: true })
    await rm(directory, { recursive: true, force: true })
  }
})
