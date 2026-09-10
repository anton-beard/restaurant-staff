/**
 * Админка без Telegram: локальная база с демо-данными, код входа печатается в консоль.
 * Запуск: npm run dev:ui (порт 3001). База: PREVIEW_DATA_DIR или ./data-preview.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildApp } from '../app.js'
import { createOwnerAuth } from '../auth/ownerAuth.js'
import { loadConfig } from '../config.js'
import { openDb } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import type { Notifier } from '../notify.js'
import { seedDemo } from './seed.js'

const dataDir = resolve(process.env.PREVIEW_DATA_DIR ?? './data-preview')
mkdirSync(join(dataDir, 'uploads'), { recursive: true })
const config = loadConfig({
  BOT_TOKEN: 'preview', OWNER_PHONE: '+10000000000', SESSION_SECRET: 'preview-secret-not-for-production', ANTHROPIC_API_KEY: 'preview',
  DATA_DIR: dataDir, PORT: process.env.PORT ?? '3001', PUBLIC_URL: `http://localhost:${process.env.PORT ?? '3001'}`, TZ: process.env.TZ ?? 'Europe/Lisbon',
})
const db = openDb(join(dataDir, 'app.db'))
setSetting(db, OWNER_TELEGRAM_ID, '1')
const seeded = seedDemo(db, new Date(), config.TZ)
console.log(seeded === 'already_seeded' ? 'Демо-данные уже в базе.' : 'Демо-данные загружены.')

const notifier: Notifier = {
  async toOwner(text) { console.log(`\n=== Сообщение владельцу ===\n${text}\n`); return 1 },
  async toEmployee() { return null },
  async photosToOwner() { return false },
  async editMessage() { return false },
}
const adminCandidates = [resolve(import.meta.dirname, '../../admin/dist'), resolve(import.meta.dirname, '../../../admin/dist')]
const adminDistDir = adminCandidates.find(existsSync) ?? adminCandidates[0]!
const app = buildApp({ config, db, auth: createOwnerAuth(db), notifier, uploadsDir: join(dataDir, 'uploads'), adminDistDir })
await app.listen({ port: config.PORT, host: '127.0.0.1' })
console.log(`Админка: ${config.PUBLIC_URL} (код входа появится здесь после «Получить код»)`)
