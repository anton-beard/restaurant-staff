import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'
import { createBot } from './bot/createBot.js'
import { notifyOwner } from './notify.js'
import { buildApp } from './app.js'

const config = loadConfig()
mkdirSync(config.DATA_DIR, { recursive: true })

const db = openDb(join(config.DATA_DIR, 'app.db'))
const auth = createOwnerAuth(db)
const bot = createBot({
  token: config.BOT_TOKEN,
  db,
  ownerPhone: config.OWNER_PHONE,
  publicUrl: config.PUBLIC_URL,
})
const app = buildApp({
  config,
  db,
  auth,
  sendToOwner: (text) => notifyOwner(bot.api, db, text),
  adminDistDir: resolve('admin/dist'),
})

await app.listen({ port: config.PORT, host: '0.0.0.0' })
void bot.start({
  onStart: (info) => app.log.info(`bot @${info.username} polling`),
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    await bot.stop()
    await app.close()
    db.close()
    process.exit(0)
  })
}
