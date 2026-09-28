import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../app.js'
import { parseEnv } from '../src/services/meli-oauth.mjs'

test('REST authentication, automatic refresh, rotation, retry and protected administration', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-api-'))
  const envPath = path.join(directory, '.env')
  await writeFile(envPath, 'MELI_CLIENT_ID=id\nMELI_CLIENT_SECRET=secret\nMELI_ACCESS_TOKEN=expired\nMELI_REFRESH_TOKEN=refresh-old\nMELI_EXPIRES_AT=2000-01-01\nMELI_URL=https://api.example.com/api/meli/callback\n')
  let refreshes = 0
  let rejectNext = false
  const fetchImpl = async (url, options) => {
    if (url.includes('/auth/v1/user')) return Response.json({}, { status: options.headers.Authorization === 'Bearer user' ? 200 : 401 })
    if (url.endsWith('/oauth/token')) {
      refreshes++
      assert.equal(options.body.get('refresh_token'), refreshes === 1 ? 'refresh-old' : `refresh-${refreshes - 1}`)
      await new Promise(resolve => setTimeout(resolve, 30))
      return Response.json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 21600 })
    }
    assert.equal(options.headers.Authorization, `Bearer access-${refreshes}`)
    if (rejectNext) { rejectNext = false; return Response.json({}, { status: 401 }) }
    return Response.json([{ id: '1', name: 'Toyota' }])
  }
  const server = createApp({ envPath, fetchImpl, config: { API_ADMIN_TOKEN: 'admin', SUPABASE_URL: 'https://supabase.example', SUPABASE_PUBLISHABLE_KEY: 'public' } }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const query = (token = 'user', payload = { attribute: 'BRAND', known: [] }) => fetch(`${base}/meli/catalog`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  assert.equal((await query('invalid')).status, 401)
  assert.equal((await query('user', { attribute: '../bad', known: [] })).status, 400)
  assert.equal((await fetch(`${base}/meli/refresh`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/meli/callback?code=bad&state=bad`)).status, 400)
  assert.equal(refreshes, 0)
  const responses = await Promise.all([query(), query(), query()])
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), [{ id: '1', name: 'Toyota' }]) }
  assert.equal(refreshes, 1)
  rejectNext = true
  assert.equal((await query()).status, 200)
  assert.equal(refreshes, 2)
  assert.equal(parseEnv(await readFile(envPath, 'utf8')).MELI_REFRESH_TOKEN, 'refresh-2')
  const status = await fetch(`${base}/meli/status`, { headers: { Authorization: 'Bearer admin' } })
  const body = await status.text()
  assert.equal(status.status, 200)
  assert.ok(!body.includes('access-2') && !body.includes('refresh-2') && !body.includes('secret'))
  const preflight = await fetch(`${base}/meli/catalog`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8081')
})
