import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { getState } from '../db/botStates.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { publishCourse } from '../db/courses.js'
import { createInstance } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createCourseAssignment, createQuizAssignment, getAttempt, getCourseAssignment, getQuizAssignment, listAttempts } from '../db/learningAssignments.js'
import { makeBot } from '../test/bot.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { callbackUpdate, photoUpdate, textUpdate, type ApiCall } from '../test/telegram.js'
import { CB } from './callbacks.js'
import type { BotContext } from './states.js'

const NOW = '2026-09-07T10:00:00.000Z'
let db: Db
let bot: Bot<BotContext>
let calls: ApiCall[]
let uploadsDir: string
let seed: ReturnType<typeof seedRestaurant>

const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => ({ to: c.payload.chat_id, text: String(c.payload.text), markup: JSON.stringify(c.payload.reply_markup ?? {}) }))
const lastText = () => texts().at(-1)?.text ?? ''
const lastAnswer = () => String(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)?.payload.text ?? '')

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  const made = makeBot(db, { now: () => new Date(NOW) }, {
    getFile: (p) => ({ file_id: p.file_id, file_unique_id: 'x', file_path: `photos/${String(p.file_id)}.jpg` }),
  })
  bot = made.bot
  calls = made.calls
  uploadsDir = made.deps.uploadsDir
})

function standalone() {
  const quiz = seedQuiz(db, [seed.positions.barista.id])
  return createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-07T18:00:00.000Z' })!
}

describe('quiz list', () => {
  it('shows pending quizzes with Start, and Continue for an open attempt', async () => {
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    expect(lastText()).toBe('Тестов нет.')
    const a = standalone()
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    expect(lastText()).toContain('«Меню недели», до 21:00')
    expect(texts().at(-1)?.markup).toContain('Начать')
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    // в состоянии quiz кнопку меню перехватывает обработчик состояния: напоминание и повтор вопроса
    expect(texts().at(-2)?.text).toBe('Идёт тест, ответьте на вопрос 1.')
    expect(lastText()).toContain('Вопрос 1 из 2')
  })
})

describe('taking a quiz', () => {
  it('asks questions one by one, ignores stale answers, fails and allows a retake, then passes', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(501, CB.quizStart(a.id)))
    expect(lastAnswer()).toBe('Это не ваш тест.')
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(lastText()).toContain('Вопрос 1 из 2')
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('quiz')
    const attempt = listAttempts(db, a.id)[0]!
    // сообщение во время теста
    await bot.handleUpdate(textUpdate(500, 'привет'))
    expect(texts().at(-2)?.text).toBe('Идёт тест, ответьте на вопрос 1.')
    expect(lastText()).toContain('Вопрос 1 из 2')
    // ответ на не тот вопрос
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 2, 0)))
    expect(lastAnswer()).toBe('Уже отвечено.')
    // неправильно, потом неправильно → провал
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 1, 1)))
    expect(lastText()).toContain('Вопрос 2 из 2')
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 2, 0)))
    expect(lastText()).toBe('Не сдано: правильных 0 из 2, нужно 80%.')
    expect(texts().at(-1)?.markup).toContain('Пересдать')
    expect(texts().some((t) => t.to === 42 && /не сдал/.test(t.text))).toBe(true)
    expect(getState(db, 500)).toBeNull()
    expect(getQuizAssignment(db, a.id)?.status).toBe('pending')
    // пересдача: оба верно
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const second = listAttempts(db, a.id)[1]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(second.id, 1, 0)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(second.id, 2, 1)))
    expect(lastText()).toBe('Сдано! 100 из 100.')
    expect(getQuizAssignment(db, a.id)).toMatchObject({ status: 'passed', passed_at: NOW })
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(lastAnswer()).toBe('Тест уже сдан.')
  })

  it('continues an open attempt from the current question', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const attempt = listAttempts(db, a.id)[0]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 1, 0)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(lastText()).toContain('Вопрос 2 из 2')
    expect(listAttempts(db, a.id)).toHaveLength(1)
  })

  it('finishes a fully answered attempt on resume if the last completion was missed', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const attempt = listAttempts(db, a.id)[0]!
    // отвечены оба вопроса, но попытка осталась незавершённой (например, обработчик не успел её закрыть)
    db.prepare('update quiz_attempts set current_question = 3, answers = ? where id = ?').run(JSON.stringify([0, 1]), attempt.id)
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    expect(lastText()).toBe('Сдано! 100 из 100.')
    expect(texts().some((t) => /Тест изменился/.test(t.text))).toBe(false)
    expect(getAttempt(db, attempt.id)).toMatchObject({ finished_at: NOW, score: 100, passed: true })
    expect(getQuizAssignment(db, a.id)).toMatchObject({ status: 'passed', passed_at: NOW })
  })

  it('closes the attempt and offers a restart when the quiz changed mid-attempt', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const attempt = listAttempts(db, a.id)[0]!
    db.prepare('delete from questions where quiz_id = ?').run(getQuizAssignment(db, a.id)!.quiz_id)
    await bot.handleUpdate(textUpdate(500, 'привет'))
    expect(lastText()).toBe('Тест изменился, начните его заново.')
    expect(texts().at(-1)?.markup).toContain(CB.quizStart(a.id))
    expect(getState(db, 500)).toBeNull()
    expect(getAttempt(db, attempt.id)).toMatchObject({ finished_at: NOW, score: null, passed: null })
    // меню снова доступно
    await bot.handleUpdate(textUpdate(500, '/start'))
    expect(lastText()).toBe('Здравствуйте, Иван Петров!')
  })

  it('postpones the quiz on Отмена and on /start, keeping the attempt open', async () => {
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    const attempt = listAttempts(db, a.id)[0]!
    await bot.handleUpdate(textUpdate(500, ' оТмена '))
    expect(lastText()).toBe('Тест отложен. Продолжить можно через «Тесты».')
    expect(getState(db, 500)).toBeNull()
    expect(getAttempt(db, attempt.id)?.finished_at).toBeNull()
    await bot.handleUpdate(textUpdate(500, 'Тесты'))
    expect(texts().at(-1)?.markup).toContain('Продолжить')
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    await bot.handleUpdate(textUpdate(500, '/start'))
    expect(lastText()).toBe('Тест отложен. Продолжить можно через «Тесты».')
    expect(getState(db, 500)).toBeNull()
    expect(listAttempts(db, a.id)).toHaveLength(1)
  })

  it('starting a quiz during photo collection discards the collected files', async () => {
    const t = createTaskTemplate(db, {
      title: 'Помыть кофемашину', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
      assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
    }, null)
    const inst = createInstance(db, { template_id: t.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: '2026-09-07T18:00:00.000Z', status: 'pending' })!
    await bot.handleUpdate(callbackUpdate(500, CB.photo(inst.id)))
    await bot.handleUpdate(photoUpdate(500, 'f1', 'u1'))
    const dir = join(uploadsDir, String(inst.id))
    expect(readdirSync(dir)).toHaveLength(1)
    const a = standalone()
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(a.id)))
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
    expect(getState<{ kind: string }>(db, 500)?.kind).toBe('quiz')
  })

  it('passing the course quiz completes the course and tells the owner', async () => {
    const { course, quiz } = seedCourse(db, [seed.positions.barista.id])
    publishCourse(db, course.id, true, NOW)
    const ca = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
    db.prepare('update course_assignments set current_lesson = 4 where id = ?').run(ca.id)
    const qa = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: ca.id, slot_at: NOW, assigned_at: NOW, due_at: '2026-09-14T10:00:00.000Z' })!
    await bot.handleUpdate(callbackUpdate(500, CB.quizStart(qa.id)))
    const attempt = listAttempts(db, qa.id)[0]!
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 1, 1)))
    await bot.handleUpdate(callbackUpdate(500, CB.quizAnswer(attempt.id, 2, 0)))
    expect(lastText()).toBe('Сдано! 100 из 100.')
    expect(getCourseAssignment(db, ca.id)).toMatchObject({ status: 'completed', completed_at: NOW })
    expect(texts().some((t) => t.to === 42 && t.text.includes('прошёл(а) курс «Эспрессо по стандарту»'))).toBe(true)
  })
})
