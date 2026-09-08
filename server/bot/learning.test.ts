import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { publishCourse } from '../db/courses.js'
import { createCourseAssignment, getCourseAssignment, listQuizAssignments } from '../db/learningAssignments.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse } from '../test/learning.js'
import { callbackUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'
import { resolveUpload } from './learning.js'
import type { BotContext } from './states.js'

const NOW = '2026-09-07T10:00:00.000Z'
let db: Db
let bot: Bot<BotContext>
let calls: ApiCall[]
let seed: ReturnType<typeof seedRestaurant>
let uploadsDir: string

const sent = () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto')
const lastText = () => String(calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload.text ?? '')
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  const made = makeBot(db, { now: () => new Date(NOW) })
  bot = made.bot
  calls = made.calls
  uploadsDir = made.deps.uploadsDir
  mkdirSync(join(uploadsDir, 'lessons'), { recursive: true })
  writeFileSync(join(uploadsDir, 'lessons', 'test.jpg'), 'jpeg')
})

function assigned() {
  const { course } = seedCourse(db, [seed.positions.barista.id])
  publishCourse(db, course.id, true, NOW)
  return createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
}

describe('course list', () => {
  it('shows an empty list, then assignments with progress and a Continue button', async () => {
    await bot.handleUpdate(textUpdate(500, 'Обучение'))
    expect(lastText()).toBe('Курсов нет.')
    const a = assigned()
    await bot.handleUpdate(textUpdate(500, 'Обучение'))
    expect(lastText()).toContain('«Эспрессо по стандарту», урок 1 из 3')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.courseContinue(a.id))
  })
})

describe('lessons', () => {
  it('sends the lesson text, media and the next button; refuses foreign assignments', async () => {
    const a = assigned()
    await bot.handleUpdate(callbackUpdate(501, CB.courseContinue(a.id)))
    expect(lastAnswer()).toBe('Это не ваш курс.')
    calls.length = 0
    await bot.handleUpdate(callbackUpdate(500, CB.courseContinue(a.id)))
    expect(sent()[0]!.payload.text).toContain('Урок 1 из 3: Помол и дозировка')
    expect(String(sent()[0]!.payload.text)).toContain('18 г')
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.courseNext(a.id, 1))
  })

  it('advances through lessons with media, ignores a repeated Next, then offers the quiz', async () => {
    const a = assigned()
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 1)))
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(2)
    const photo = calls.find((c) => c.method === 'sendPhoto')
    expect(photo).toBeDefined()
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('https://youtu.be/x'))).toBe(true)
    expect(lastText()).toBe('Нажмите, когда прочитаете.')
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 1)))
    expect(lastAnswer()).toBe('Уже отмечено.')
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(2)
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 2)))
    expect(getCourseAssignment(db, a.id)?.current_lesson).toBe(3)
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 3)))
    expect(lastText()).toBe('Уроки пройдены, остался итоговый тест.')
    const qa = listQuizAssignments(db, { employee_id: seed.employees.ivan.id })
    expect(qa).toHaveLength(1)
    expect(qa[0]).toMatchObject({ course_assignment_id: a.id, status: 'pending', due_at: '2026-09-14T10:00:00.000Z' })
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain(CB.quizStart(qa[0]!.id))
    // повторное «Дальше» на последнем уроке не создаёт второе назначение
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 3)))
    expect(listQuizAssignments(db, { employee_id: seed.employees.ivan.id })).toHaveLength(1)
  })

  it('skips a lesson image whose path escapes uploadsDir, but still sends the lesson text and next-button prompt', async () => {
    const a = assigned()
    const row = getCourseAssignment(db, a.id)!
    db.prepare('update lessons set media = ? where course_id = ? and position = 2').run(JSON.stringify([{ kind: 'image', path: '../../outside.jpg' }]), row.course_id)
    calls.length = 0
    await bot.handleUpdate(callbackUpdate(500, CB.courseNext(a.id, 1)))
    expect(calls.some((c) => c.method === 'sendPhoto')).toBe(false)
    expect(sent().some((c) => c.method === 'sendMessage' && String(c.payload.text).includes('Экстракция'))).toBe(true)
    expect(lastText()).toBe('Нажмите, когда прочитаете.')
  })
})

describe('resolveUpload', () => {
  it('resolves a path inside uploadsDir', () => {
    expect(resolveUpload('/data/uploads', 'lessons/2026-09/a.jpg')).toBe(join('/data/uploads', 'lessons/2026-09/a.jpg'))
  })

  it('rejects a path that escapes uploadsDir via ..', () => {
    expect(resolveUpload('/data/uploads', '../secret')).toBeNull()
  })

  it('rejects an absolute path outside uploadsDir', () => {
    expect(resolveUpload('/data/uploads', '/etc/passwd')).toBeNull()
  })

  it('rejects an empty path', () => {
    expect(resolveUpload('/data/uploads', '')).toBeNull()
  })
})
