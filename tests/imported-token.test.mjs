import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCatalog } from '../src/services/catalog.mjs'

test('imported access token works without expiry or refresh token and requires authorization on rejection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carmeet-imported-'))
  const envPath = path.join(directory, '.env')
  await writeFile(envPath, 'MELI_ACCESS_TOKEN=imported\nMELI_REFRESH_TOKEN=\nMELI_EXPIRES_AT=\n')
  let rejected = false
  let calls = 0
  const catalog = createCatalog({ envPath, fetchImpl: async (url, options) => {
    calls++
    assert.ok(url.includes('/top_values'))
    assert.equal(options.headers.Authorization, 'Bearer imported')
    return Response.json(rejected ? {} : [{ id: '1', name: 'Toyota' }], { status: rejected ? 401 : 200 })
  } })
  assert.deepEqual(await catalog.query({ attribute: 'BRAND', known: [] }), [{ id: '1', name: 'Toyota' }])
  rejected = true
  await assert.rejects(catalog.query({ attribute: 'BRAND', known: [] }), { code: 'MELI_REAUTH_REQUIRED' })
  assert.equal(calls, 2)
})
