import { loadConfig } from './config.js'
import { buildApp } from './app.js'

const config = loadConfig()
const app = buildApp({ config })

await app.listen({ port: config.PORT, host: '0.0.0.0' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    process.exit(0)
  })
}
