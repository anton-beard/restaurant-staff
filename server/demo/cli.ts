import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDb } from '../db/connect.js'
import { seedDemo } from './seed.js'

const dataDir = resolve(process.env.DATA_DIR ?? './data')
const tz = process.env.TZ ?? 'Europe/Moscow'
mkdirSync(dataDir, { recursive: true })
const db = openDb(join(dataDir, 'app.db'))

const result = seedDemo(db, new Date(), tz)
if (result === 'already_seeded') {
  console.log('Демо-данные уже загружены, повторно ничего не добавлено.')
} else {
  console.log(
    `Демо-данные загружены: сотрудников ${result.employees}, шаблонов заданий ${result.templates}, ` +
      `экземпляров заданий ${result.instances}, курсов ${result.courses}, тестов ${result.quizzes}.`,
  )
  console.log('Демо-сотрудники привязаны к вымышленным Telegram-аккаунтам: сообщения им не доставляются, задания по расписанию будут уходить в просрочку.')
}
db.close()
