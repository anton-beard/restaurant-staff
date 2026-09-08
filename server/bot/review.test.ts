import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { getState } from '../db/botStates.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createInstance, getInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, getSubmission, saveAiResult } from '../db/taskSubmissions.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { callbackUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'

const NOW = '2026-09-07T19:00:00.000Z'
let db: Db
let bot: Bot
let calls: ApiCall[]
let subId: number
let instId: number

const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => ({ to: c.payload.chat_id, text: String(c.payload.text) }))
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  const seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  ;({ bot, calls } = makeBot(db))
  const t = createTaskTemplate(db, {
    title: 'Помыть кофемашину', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  instId = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'review' })!.id
  subId = createSubmission(db, instId, NOW, [{ path: 'a.jpg', fileUniqueId: 'u1' }]).id
  saveAiResult(db, subId, { score: 50, verdict: 'Поддон грязный', issues: ['поддон'] }, 'needs_review', NOW)
})

describe('owner review in bot', () => {
  it('only the owner can decide', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.accept(subId)))
    expect(lastAnswer()).toBe('Только для владельца.')
    expect(getSubmission(db, subId)?.decision).toBe('needs_review')
  })

  it('accept closes the task and notifies the employee', async () => {
    await bot.handleUpdate(callbackUpdate(42, CB.accept(subId)))
    expect(getSubmission(db, subId)?.decision).toBe('owner_accepted')
    expect(getInstance(db, instId)?.status).toBe('accepted')
    expect(texts().some((t) => t.to === 500 && /принято/i.test(t.text))).toBe(true)
    expect(texts().some((t) => t.to === 42 && t.text.startsWith('Принято: Помыть кофемашину'))).toBe(true)
    await bot.handleUpdate(callbackUpdate(42, CB.accept(subId)))
    expect(lastAnswer()).toBe('Уже решено.')
  })

  it('reject asks for a comment, then reopens the task with it', async () => {
    await bot.handleUpdate(callbackUpdate(42, CB.reject(subId)))
    expect(texts().at(-1)?.text).toBe('Напишите комментарий для сотрудника.')
    expect(getState<{ kind: string }>(db, 42)?.kind).toBe('reject_comment')
    await bot.handleUpdate(textUpdate(42, 'Поддон нужно вымыть'))
    expect(getSubmission(db, subId)).toMatchObject({ decision: 'owner_rejected', owner_comment: 'Поддон нужно вымыть' })
    expect(getInstance(db, instId)?.status).toBe('pending')
    expect(texts().some((t) => t.to === 500 && t.text.includes('Поддон нужно вымыть'))).toBe(true)
    expect(texts().at(-1)?.text).toBe('Отклонено, сотруднику отправлено.')
    expect(getState(db, 42)).toBeNull()
  })

  it('cancel leaves the comment mode without deciding', async () => {
    await bot.handleUpdate(callbackUpdate(42, CB.reject(subId)))
    await bot.handleUpdate(textUpdate(42, 'Отмена'))
    expect(texts().at(-1)?.text).toBe('Отменено.')
    expect(getState(db, 42)).toBeNull()
    expect(getSubmission(db, subId)?.decision).toBe('needs_review')
  })

  it('summary shows the review queue and overdue counters', async () => {
    await bot.handleUpdate(textUpdate(42, 'Сводка'))
    expect(texts().at(-1)?.text).toContain('На проверке: 1')
    expect(texts().at(-1)?.text).toContain('Просрочено за сутки: 0')
  })
})
