import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { getSubmission } from '../db/taskSubmissions.js'
import { createReviewQueue, type ReviewQueue } from '../tasks/reviewQueue.js'
import type { ReviewResult } from '../ai/photoReview.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { callbackUpdate, photoUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'

// Сквозная цепочка: сотрудник отправляет фото -> очередь зовёт модель -> низкий балл уходит
// владельцу с кнопками -> владелец отклоняет с комментарием -> задание возвращается сотруднику.
const NOW = new Date('2026-09-07T19:00:00.000Z')
let db: Db
let bot: Bot
let calls: ApiCall[]
let queue: ReviewQueue
let instId: number
let score: number

const sent = (method: string, chatId: number) => calls.filter((c) => c.method === method && c.payload.chat_id === chatId)
const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => ({ to: c.payload.chat_id, text: String(c.payload.text) }))

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  score = 40
  const made = makeBot(
    db,
    { onSubmission: (id) => void queue.enqueue(id) },
    { getFile: (p) => ({ file_id: p.file_id, file_unique_id: 'x', file_path: `photos/${String(p.file_id)}.jpg` }) },
  )
  bot = made.bot
  calls = made.calls
  queue = createReviewQueue({
    db,
    notifier: made.notifier,
    uploadsDir: made.deps.uploadsDir,
    reviewer: async (): Promise<ReviewResult> => ({ score, verdict: 'Поддон не отмыт', issues: ['поддон'] }),
    now: () => NOW,
  })
  const t = createTaskTemplate(db, {
    title: 'Помыть кофемашину', description: 'Группы и поддон', requires_photo: true, photo_criteria: 'Чисто',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null,
    deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  instId = createInstance(db, {
    template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW.toISOString(),
    issued_at: NOW.toISOString(), due_at: '2026-09-07T20:00:00.000Z', status: 'pending',
  })!.id
})

describe('photo submission end to end', () => {
  it('goes from the employee photo to the owner rejection and back to the employee', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    await bot.handleUpdate(textUpdate(500, 'Готово'))
    expect(texts().some((t) => t.to === 500 && t.text.includes('Проверяю'))).toBe(true)

    await queue.idle()
    const subId = 1
    expect(getSubmission(db, subId)).toMatchObject({ ai_status: 'done', ai_score: 40, decision: 'needs_review' })
    expect(getInstance(db, instId)?.status).toBe('review')
    expect(texts().some((t) => t.to === 500 && t.text.includes('владельцу'))).toBe(true)
    const toOwner = [...sent('sendPhoto', 42), ...sent('sendMessage', 42)]
    expect(toOwner.some((c) => JSON.stringify(c.payload.reply_markup ?? '').includes(`review:reject:${subId}`))).toBe(true)

    await bot.handleUpdate(callbackUpdate(42, CB.reject(subId)))
    await bot.handleUpdate(textUpdate(42, 'Переснимите'))
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_rejected', owner_comment: 'Переснимите' })
    expect(getInstance(db, instId)?.status).toBe('pending')
    expect(texts().some((t) => t.to === 500 && t.text.includes('Переснимите'))).toBe(true)
    expect(texts().at(-1)).toMatchObject({ to: 42, text: 'Отклонено, сотруднику отправлено.' })
  })

  it('auto-accepts a high score without bothering the owner', async () => {
    score = 95
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    await bot.handleUpdate(textUpdate(500, 'Готово'))
    await queue.idle()
    expect(getSubmission(db, 1)?.decision).toBe('auto_accepted')
    expect(getInstance(db, instId)).toMatchObject({ status: 'accepted', completed_at: NOW.toISOString() })
    expect(texts().some((t) => t.to === 500 && t.text.includes('95'))).toBe(true)
    expect(sent('sendPhoto', 42)).toHaveLength(0)
  })
})
