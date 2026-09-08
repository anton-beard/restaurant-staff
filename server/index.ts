import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Api } from 'grammy'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'
import { createBot } from './bot/createBot.js'
import { telegramDownloader } from './bot/files.js'
import { createTelegramNotifier } from './notify.js'
import { buildApp } from './app.js'

const config = loadConfig()
mkdirSync(config.DATA_DIR, { recursive: true })
const uploadsDir = join(config.DATA_DIR, 'uploads')
mkdirSync(uploadsDir, { recursive: true })

// dist/server/index.js -> ../../admin/dist; server/index.ts under tsx -> ../admin/dist.
const adminCandidates = [
  resolve(import.meta.dirname, '../../admin/dist'),
  resolve(import.meta.dirname, '../admin/dist'),
]
const adminDistDir = adminCandidates.find(existsSync) ?? adminCandidates[0]!

const db = openDb(join(config.DATA_DIR, 'app.db'))
const auth = createOwnerAuth(db)
const api = new Api(config.BOT_TOKEN)
const notifier = createTelegramNotifier(api, db)
const bot = createBot({
  token: config.BOT_TOKEN,
  deps: {
    db,
    ownerPhone: config.OWNER_PHONE,
    publicUrl: config.PUBLIC_URL,
    notifier,
    tz: config.TZ,
    uploadsDir,
    downloadFile: telegramDownloader(config.BOT_TOKEN),
    // TODO(Task 7/11): wire to the review queue once it exists.
    onSubmission: () => undefined,
    now: () => new Date(),
  },
})
const app = buildApp({ config, db, auth, notifier, uploadsDir, adminDistDir })

await app.listen({ port: config.PORT, host: '0.0.0.0' })
bot
  .start({
    onStart: (info) => app.log.info(`bot @${info.username} polling`),
  })
  .catch((err: unknown) => {
    app.log.error(err, 'bot failed to start, shutting down')
    process.exit(1)
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
