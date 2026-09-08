import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Api } from 'grammy'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'
import { createBot } from './bot/createBot.js'
import { telegramDownloader } from './bot/files.js'
import { createTelegramNotifier } from './notify.js'
import { createReviewer } from './ai/photoReview.js'
import { createReviewQueue } from './tasks/reviewQueue.js'
import { createScheduler } from './scheduler/tick.js'
import { buildApp } from './app.js'

const config = loadConfig()
const dataDir = resolve(config.DATA_DIR)
mkdirSync(dataDir, { recursive: true })
const uploadsDir = join(dataDir, 'uploads')
mkdirSync(uploadsDir, { recursive: true })

// dist/server/index.js -> ../../admin/dist; server/index.ts under tsx -> ../admin/dist.
const adminCandidates = [resolve(import.meta.dirname, '../../admin/dist'), resolve(import.meta.dirname, '../admin/dist')]
const adminDistDir = adminCandidates.find(existsSync) ?? adminCandidates[0]!

const db = openDb(join(dataDir, 'app.db'))
const auth = createOwnerAuth(db)
const api = new Api(config.BOT_TOKEN)
const notifier = createTelegramNotifier(api, db)
const reviewQueue = createReviewQueue({
  db,
  notifier,
  tz: config.TZ,
  uploadsDir,
  reviewer: createReviewer(config.ANTHROPIC_API_KEY, config.AI_MODEL),
})
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
    onSubmission: (id) => reviewQueue.enqueue(id),
    now: () => new Date(),
  },
})
const app = buildApp({ config, db, auth, notifier, uploadsDir, adminDistDir })
const scheduler = createScheduler({ db, notifier, tz: config.TZ, uploadsDir, reviewQueue })

await app.listen({ port: config.PORT, host: '0.0.0.0' })
const stopScheduler = scheduler.start()
bot
  .start({ onStart: (info) => app.log.info(`bot @${info.username} polling, model ${config.AI_MODEL}, tz ${config.TZ}`) })
  .catch((err: unknown) => {
    app.log.error(err, 'bot failed to start, shutting down')
    process.exit(1)
  })

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    stopScheduler()
    await bot.stop()
    await reviewQueue.idle()
    await app.close()
    db.close()
    process.exit(0)
  })
}
