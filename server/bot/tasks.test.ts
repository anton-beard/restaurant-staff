import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { getState } from '../db/botStates.js'
import { createInstance, addOffer, getInstance, getInstanceRow } from '../db/taskInstances.js'
import { createTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { getSubmission, listPhotos } from '../db/taskSubmissions.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { callbackUpdate, photoUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'
import type { CollectingState } from './tasks.js'

const NOW = '2026-09-07T19:00:00.000Z'
const DUE = '2026-09-07T20:00:00.000Z'
let db: Db
let bot: Bot
let calls: ApiCall[]
let uploadsDir: string
let submitted: number[]
let seed: ReturnType<typeof seedRestaurant>

const tpl = (over: Partial<TaskTemplateInput> = {}): TaskTemplateInput => ({
  title: 'Помыть кофемашину', description: 'Группы и поддон', requires_photo: true, photo_criteria: 'Чисто',
  auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each', schedule: null,
  deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [], ...over,
})
const pendingFor = (templateId: number, employeeId: number) =>
  createInstance(db, { template_id: templateId, employee_id: employeeId, slot_at: NOW, issued_at: NOW, due_at: DUE, status: 'pending' })!

const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))
const lastText = () => texts().at(-1) ?? ''
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  submitted = []
  const made = makeBot(db, { onSubmission: (id) => submitted.push(id) }, {
    getFile: (p) => ({ file_id: p.file_id, file_unique_id: 'x', file_path: `photos/${String(p.file_id)}.jpg` }),
  })
  bot = made.bot
  calls = made.calls
  uploadsDir = made.deps.uploadsDir
})

describe('task list and card', () => {
  it('shows an empty list, then tasks with an Open button', async () => {
    await bot.handleUpdate(textUpdate(500, 'Мои задания'))
    expect(lastText()).toBe('Активных заданий нет.')
    const t = createTaskTemplate(db, tpl(), null)
    pendingFor(t.id, seed.employees.ivan.id)
    await bot.handleUpdate(textUpdate(500, 'Мои задания'))
    expect(lastText()).toContain('Помыть кофемашину')
    expect(lastText()).toContain('до 23:00')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.open(1))
  })

  it('opens a card, refuses foreign tasks, completes a no-photo task', async () => {
    const t = createTaskTemplate(db, tpl({ requires_photo: false, photo_criteria: null }), null)
    const inst = pendingFor(t.id, seed.employees.ivan.id)
    await bot.handleUpdate(callbackUpdate(501, CB.open(inst.id)))
    expect(lastAnswer()).toBe('Это не ваше задание.')
    await bot.handleUpdate(callbackUpdate(500, CB.open(inst.id)))
    expect(lastText()).toContain('Группы и поддон')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.done(inst.id))
    await bot.handleUpdate(callbackUpdate(500, CB.done(inst.id)))
    expect(lastText()).toBe('Принято! Задание выполнено.')
    expect(getInstance(db, inst.id)).toMatchObject({ status: 'accepted', completed_at: NOW })
    await bot.handleUpdate(callbackUpdate(500, CB.done(inst.id)))
    expect(lastAnswer()).toBe('Задание уже не активно.')
  })
})

describe('shared task claim', () => {
  it('first claimer wins, others see who took it', async () => {
    const t = createTaskTemplate(db, tpl({ distribution: 'shared' }), null)
    const inst = createInstance(db, { template_id: t.id, employee_id: null, slot_at: NOW, issued_at: NOW, due_at: DUE, status: 'open' })!
    addOffer(db, inst.id, 500, 10)
    addOffer(db, inst.id, 501, 11)
    await bot.handleUpdate(callbackUpdate(500, CB.claim(inst.id), 10))
    expect(getInstanceRow(db, inst.id)).toMatchObject({ status: 'pending', employee_id: seed.employees.ivan.id })
    const edits = calls.filter((c) => c.method === 'editMessageText')
    expect(edits.some((c) => c.payload.chat_id === 501 && c.payload.message_id === 11 && String(c.payload.text).includes('Взял(а) Иван Петров'))).toBe(true)
    expect(lastText()).toContain('Помыть кофемашину')
    await bot.handleUpdate(callbackUpdate(501, CB.claim(inst.id), 11))
    expect(lastAnswer()).toBe('Уже взяли.')
  })
})

describe('photo collection', () => {
  let instId: number
  beforeEach(() => {
    const t = createTaskTemplate(db, tpl(), null)
    instId = pendingFor(t.id, seed.employees.ivan.id).id
  })

  it('needs the photo mode first', async () => {
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    expect(lastText()).toBe('Сначала откройте задание и нажмите «Отправить фото».')
  })

  it('collects up to 3 photos, rejects duplicates, submits', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    expect(lastText()).toBe('Пришлите до 3 фото, потом нажмите Готово.')
    await bot.handleUpdate(textUpdate(500, 'Готово'))
    expect(lastText()).toBe('Нужно хотя бы одно фото.')
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    expect(lastText()).toBe('Фото 1 из 3 получено.')
    expect(calls.some((c) => c.method === 'getFile')).toBe(true)
    expect(readdirSync(join(uploadsDir, String(instId)))).toHaveLength(1)
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    expect(lastText()).toBe('Это фото уже отправляли, снимите заново.')
    await bot.handleUpdate(photoUpdate(500, 'f2', 'u2'))
    await bot.handleUpdate(photoUpdate(500, 'f3', 'u3'))
    await bot.handleUpdate(photoUpdate(500, 'f4', 'u4'))
    expect(lastText()).toBe('Максимум 3 фото.')
    await bot.handleUpdate(textUpdate(500, 'Готово'))
    expect(lastText()).toBe('Проверяю, это займёт до минуты.')
    expect(submitted).toEqual([1])
    const sub = getSubmission(db, 1)!
    expect(sub).toMatchObject({ instance_id: instId, ai_status: 'pending' })
    expect(listPhotos(db, 1)).toHaveLength(3)
    expect(getInstance(db, instId)?.status).toBe('submitted')
    expect(getState(db, 500)).toBeNull()
  })

  it('keeps the collection alive when a stray message arrives', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    await bot.handleUpdate(textUpdate(500, 'привет'))
    expect(lastText()).toBe('Сейчас идёт отправка фото. Пришлите фото, затем нажмите Готово, или нажмите Отмена.')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain('Готово')
    expect(getState<CollectingState>(db, 500)?.kind).toBe('collecting_photos')
    expect(getState<CollectingState>(db, 500)?.photos).toHaveLength(1)
  })

  it('accepts Готово with stray spaces and mixed case', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    await bot.handleUpdate(textUpdate(500, ' гОтОво '))
    expect(lastText()).toBe('Проверяю, это займёт до минуты.')
    expect(submitted).toEqual([1])
    expect(getInstance(db, instId)?.status).toBe('submitted')
    expect(listPhotos(db, 1)).toHaveLength(1)
    expect(getState(db, 500)).toBeNull()
  })

  it('accepts Отмена in upper case', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    await bot.handleUpdate(textUpdate(500, 'ОТМЕНА'))
    expect(lastText()).toBe('Отменено.')
    expect(getState(db, 500)).toBeNull()
    expect(getInstance(db, instId)?.status).toBe('pending')
  })

  it('cancel removes files and state', async () => {
    await bot.handleUpdate(callbackUpdate(500, CB.photo(instId)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    const dir = join(uploadsDir, String(instId))
    expect(readdirSync(dir)).toHaveLength(1)
    await bot.handleUpdate(textUpdate(500, 'Отмена'))
    expect(lastText()).toBe('Отменено.')
    expect(getState(db, 500)).toBeNull()
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
    expect(getInstance(db, instId)?.status).toBe('pending')
  })
})
