import { startAuthorization, exchangeCode, refreshToken, readConfig } from '../src/services/meli-oauth.mjs'

try {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'authorize') console.log((await startAuthorization()).url)
  else if (command === 'exchange') {
    const index = args.indexOf('--callback')
    console.log(await exchangeCode(undefined, index >= 0 ? args[index + 1] : undefined))
  } else if (command === 'refresh') console.log(await refreshToken())
  else if (command === 'status') {
    const { values } = await readConfig()
    console.log({ hasAccess: !!values.MELI_ACCESS_TOKEN, hasRefresh: !!values.MELI_REFRESH_TOKEN, expiresAt: values.MELI_EXPIRES_AT || null })
  } else throw new Error('Uso: authorize | exchange --callback URL | refresh | status')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
