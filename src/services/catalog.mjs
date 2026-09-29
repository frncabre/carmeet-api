import { readConfig, refreshToken, defaultEnvPath } from './meli-oauth.mjs'

export function validRequest(value) {
  if (!value || typeof value !== 'object') return false
  const { attribute, known } = value
  if (!['BRAND', 'MODEL', 'TRIM', 'VEHICLE_YEAR'].includes(attribute) || !Array.isArray(known)) return false
  const expected = attribute === 'BRAND' ? [] : attribute === 'MODEL' ? ['BRAND'] : ['BRAND', 'MODEL']
  return known.length === expected.length && known.every((item, i) => item?.id === expected[i]
    && typeof item.value_id === 'string' && /^\d{1,20}$/.test(item.value_id))
}

export function createCatalog({ envPath = defaultEnvPath, fetchImpl = fetch } = {}) {
  let refreshing
  function refresh() {
    if (!refreshing) refreshing = refreshToken(envPath, fetchImpl).finally(() => { refreshing = undefined })
    return refreshing
  }
  async function accessToken(rejectedToken) {
    let { values } = await readConfig(envPath)
    const expiresAt = Date.parse(values.MELI_EXPIRES_AT)
    // Imported tokens may have no issuance date. Try them before refreshing.
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60000
    if (!values.MELI_ACCESS_TOKEN || (rejectedToken ? values.MELI_ACCESS_TOKEN === rejectedToken : expired)) {
      if (!values.MELI_REFRESH_TOKEN) {
        const error = new Error('La autorización de Mercado Libre venció o fue rechazada y no hay refresh token. Volvé a autorizar la aplicación.')
        error.code = 'MELI_REAUTH_REQUIRED'
        throw error
      }
      await refresh()
      values = (await readConfig(envPath)).values
    }
    return values.MELI_ACCESS_TOKEN
  }
  return {
    refresh,
    async query(payload) {
      let token = await accessToken()
      const request = () => fetchImpl(`https://api.mercadolibre.com/catalog_domains/MLA-CARS_AND_VANS/attributes/${payload.attribute}/top_values?limit=1000`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ known_attributes: payload.known }),
        signal: AbortSignal.timeout(15000),
      })
      let response = await request()
      if (response.status === 401) {
        token = await accessToken(token)
        response = await request()
      }
      if (!response.ok) throw new Error('El proveedor rechazó la consulta del catálogo.')
      const values = await response.json()
      if (!Array.isArray(values)) throw new Error('Formato de catálogo inválido.')
      return values
    },
  }
}
