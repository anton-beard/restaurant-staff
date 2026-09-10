import type { Db } from '../db/connect.js'
import { createCourseAssignment, completeCourseAssignment, createAttempt, createQuizAssignment, finishAttempt, markQuizPassed, recordAnswer, setCourseAssignmentStatus, setQuizAssignmentStatus } from '../db/learningAssignments.js'
import { createCourse, publishCourse, replaceLessons } from '../db/courses.js'
import { createEmployee, findEmployeeByPhone, linkTelegram, type Employee } from '../db/employees.js'
import { createPosition, listPositions, type Position } from '../db/positions.js'
import { createQuiz, listQuestions, replaceQuestions, setQuizStatus, type Quiz } from '../db/quizzes.js'
import { getSetting, setSetting } from '../db/settings.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createSubmission, saveAiResult, setOwnerDecision } from '../db/taskSubmissions.js'
import { createTaskTemplate, type TaskTemplateInput } from '../db/taskTemplates.js'
import { scoreAnswers } from '../learning/score.js'
import { addDays, localParts, zonedToUtc } from '../lib/time.js'
import { nextRun, slotsForDay, type Schedule } from '../tasks/schedule.js'

export const DEMO_SEEDED_AT = 'demo_seeded_at'
const DAYS_BACK = 30
const HOUR = 60 * 60_000

/** Детерминированный генератор: один и тот же набор данных при каждом запуске. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Profile = { onTime: number; late: number }
type DemoEmployee = { full_name: string; phone: string; position: 'cook' | 'admin' | 'barista'; telegram: number | null; profile: Profile }

const EMPLOYEES: DemoEmployee[] = [
  { full_name: 'Мария Иванова', phone: '+351910000001', position: 'barista', telegram: 900000001, profile: { onTime: 0.92, late: 0.05 } },
  { full_name: 'Алексей Соколов', phone: '+351910000002', position: 'barista', telegram: 900000002, profile: { onTime: 0.75, late: 0.12 } },
  { full_name: 'Дарья Козлова', phone: '+351910000003', position: 'barista', telegram: 900000003, profile: { onTime: 0.58, late: 0.15 } },
  { full_name: 'Сергей Волков', phone: '+351910000004', position: 'cook', telegram: 900000004, profile: { onTime: 0.86, late: 0.08 } },
  { full_name: 'Николай Морозов', phone: '+351910000005', position: 'cook', telegram: 900000005, profile: { onTime: 0.68, late: 0.12 } },
  { full_name: 'Елена Лебедева', phone: '+351910000006', position: 'admin', telegram: 900000006, profile: { onTime: 0.95, late: 0.04 } },
  { full_name: 'Артём Павлов', phone: '+351910000007', position: 'barista', telegram: null, profile: { onTime: 0, late: 0 } },
]

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7]

type DemoTemplate = Omit<TaskTemplateInput, 'position_ids' | 'employee_ids'> & { positions: DemoEmployee['position'][] }

const TEMPLATES: DemoTemplate[] = [
  {
    title: 'Помыть кофемашину', description: 'Промыть группы, холдеры и капучинатор, протереть корпус.',
    requires_photo: true, photo_criteria: 'Чистые группы и холдеры, нет молочных подтёков на капучинаторе, корпус без разводов.',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each',
    schedule: { kind: 'weekly', days: EVERY_DAY, times: ['22:00'] }, deadline_minutes: 60, positions: ['barista'],
  },
  {
    title: 'Убрать стулья с улицы', description: 'Занести стулья и столы с террасы, сложить у стены.',
    requires_photo: false, photo_criteria: null, auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'shared',
    schedule: { kind: 'weekly', days: EVERY_DAY, times: ['21:30'] }, deadline_minutes: 45, positions: ['barista', 'admin'],
  },
  {
    title: 'Разобрать поставку кофе', description: 'Принять поставку, сверить с накладной, разложить по полкам по датам.',
    requires_photo: true, photo_criteria: 'Пачки на полках этикетками наружу, ранние даты спереди, коробки убраны.',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'shared',
    schedule: { kind: 'weekly', days: [2, 5], times: ['10:00'] }, deadline_minutes: 120, positions: ['barista'],
  },
  {
    title: 'Проверить сроки годности в холодильнике', description: 'Проверить маркировку и сроки, просроченное списать.',
    requires_photo: true, photo_criteria: 'На каждом контейнере маркировка с датой, нет продуктов без этикеток, полки чистые.',
    auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each',
    schedule: { kind: 'weekly', days: EVERY_DAY, times: ['09:00'] }, deadline_minutes: 60, positions: ['cook'],
  },
  {
    title: 'Заполнить чек-лист открытия', description: 'Касса, терминал, музыка, витрина, туалеты.',
    requires_photo: false, photo_criteria: null, auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'each',
    schedule: { kind: 'weekly', days: EVERY_DAY, times: ['08:30'] }, deadline_minutes: 30, positions: ['admin'],
  },
  {
    title: 'Мыть полы в зале', description: 'Влажная уборка зала и входной группы после закрытия.',
    requires_photo: false, photo_criteria: null, auto_accept_threshold: 80, assignee_mode: 'by_position', distribution: 'shared',
    schedule: { kind: 'weekly', days: EVERY_DAY, times: ['22:30'] }, deadline_minutes: 60, positions: ['barista', 'cook'],
  },
]

type Lesson = { title: string; body: string }
type Question = { text: string; options: string[]; correct_index: number }
type Outcome = 'pass' | 'retry' | 'in_progress' | 'overdue'
type DemoCourse = {
  title: string; description: string; due_days: number; positions: DemoEmployee['position'][]; publishedDaysAgo: number
  /** Исход по каждому ученику по порядку: сдал сразу / со второй попытки / ещё проходит / просрочил. */
  outcomes: Outcome[]
  lessons: Lesson[]; questions: Question[]
}

const COURSES: DemoCourse[] = [
  {
    title: 'Эспрессо по стандарту', description: 'Базовый курс бариста: помол, экстракция, молоко.', due_days: 7, positions: ['barista'], publishedDaysAgo: 20, outcomes: ['pass', 'retry', 'in_progress'],
    lessons: [
      { title: 'Помол и дозировка', body: 'Помол под эспрессо: 18 г на двойной холдер. Проверяем помол каждое утро, после смены зерна и при изменении влажности.' },
      { title: 'Экстракция', body: 'Экстракция 25–30 секунд, выход 36 г. Если быстрее — помол мельче, если дольше — крупнее.' },
      { title: 'Молоко', body: 'Взбиваем до 60–65 °C, пена глянцевая, без крупных пузырей. Кувшин моем после каждого напитка.' },
    ],
    questions: [
      { text: 'Сколько секунд длится экстракция эспрессо?', options: ['10–15', '25–30', '50–60'], correct_index: 1 },
      { text: 'До какой температуры взбиваем молоко?', options: ['60–65 °C', '80–90 °C', 'До кипения'], correct_index: 0 },
      { text: 'Эспрессо льётся слишком быстро. Что делаем?', options: ['Помол крупнее', 'Помол мельче', 'Меньше воды'], correct_index: 1 },
    ],
  },
  {
    title: 'Санитарные нормы кухни', description: 'Маркировка, товарное соседство, сроки хранения.', due_days: 5, positions: ['cook'], publishedDaysAgo: 15, outcomes: ['pass', 'overdue'],
    lessons: [
      { title: 'Маркировка', body: 'На каждом контейнере: название, дата и время вскрытия, срок годности, подпись.' },
      { title: 'Товарное соседство', body: 'Сырое мясо и рыба на нижних полках, готовые блюда и овощи выше. Никогда не наоборот.' },
      { title: 'Сроки хранения', body: 'Вскрытые соусы 3 дня, заготовки 24 часа, размороженное не замораживаем повторно.' },
    ],
    questions: [
      { text: 'Где хранится сырое мясо?', options: ['На верхней полке', 'На нижней полке', 'Где есть место'], correct_index: 1 },
      { text: 'Сколько хранятся заготовки?', options: ['24 часа', '3 дня', 'Неделю'], correct_index: 0 },
      { text: 'Что обязательно на маркировке?', options: ['Только название', 'Название, дата вскрытия и срок', 'Цена'], correct_index: 1 },
    ],
  },
  {
    title: 'Стандарты сервиса', description: 'Встреча гостя, работа с жалобами, закрытие смены.', due_days: 7, positions: ['admin'], publishedDaysAgo: 10, outcomes: ['pass'],
    lessons: [
      { title: 'Встреча гостя', body: 'Поздороваться в первые 10 секунд, предложить стол, принести меню сразу.' },
      { title: 'Жалобы', body: 'Выслушать, извиниться, предложить решение. Спорные случаи — к владельцу в тот же день.' },
      { title: 'Закрытие смены', body: 'Снять кассу, сверить терминал, заполнить чек-лист закрытия, включить сигнализацию.' },
    ],
    questions: [
      { text: 'За сколько секунд нужно поздороваться с гостем?', options: ['10', '60', 'Как получится'], correct_index: 0 },
      { text: 'Гость жалуется на блюдо. Первый шаг?', options: ['Спорить', 'Выслушать и извиниться', 'Позвать повара'], correct_index: 1 },
      { text: 'Что делаем при закрытии смены?', options: ['Только выключаем свет', 'Снимаем кассу и заполняем чек-лист', 'Ничего'], correct_index: 1 },
    ],
  },
]

const MENU_QUIZ: { schedule: Schedule; questions: Question[] } = {
  schedule: { kind: 'weekly', days: [1], times: ['10:00'] },
  questions: [
    { text: 'Что в сезонном меню на этой неделе?', options: ['Тыквенный латте', 'Окрошка', 'Глинтвейн'], correct_index: 0 },
    { text: 'Цена капучино 300 мл?', options: ['250', '300', '350'], correct_index: 1 },
    { text: 'Какое блюдо дня в четверг?', options: ['Паста с грибами', 'Борщ', 'Ризотто'], correct_index: 2 },
  ],
}

export type SeedResult = { employees: number; templates: number; instances: number; courses: number; quizzes: number }

/** Наполняет базу демо-данными за последние 30 дней. Повторный запуск не делает ничего. */
export function seedDemo(db: Db, now: Date, tz: string): SeedResult | 'already_seeded' {
  if (getSetting(db, DEMO_SEEDED_AT)) return 'already_seeded'
  const random = rng(42)
  return db.transaction(() => {
    const positions = ensurePositions(db)
    const employees = ensureEmployees(db, positions)
    const byPosition = (keys: DemoEmployee['position'][]) =>
      employees.filter((e) => e.telegram !== null && keys.includes(e.position))

    let instances = 0
    for (const t of TEMPLATES) {
      const schedule = t.schedule!
      const template = createTaskTemplate(db, {
        ...t, position_ids: t.positions.map((p) => positions[p].id), employee_ids: [],
      }, nextRun(schedule, now, tz).toISOString())
      const eligible = byPosition(t.positions)
      for (const slot of pastSlots(schedule, now, tz)) {
        const assignees = t.distribution === 'each' ? eligible : [pick(random, eligible)]
        for (const e of assignees) {
          instances++
          seedInstance(db, template.id, e, slot, t, now, random)
        }
      }
    }

    let quizzes = 0
    for (const c of COURSES) {
      seedCourse(db, c, positions, byPosition(c.positions), now, random)
      quizzes++
    }
    seedMenuQuiz(db, positions, byPosition(['barista', 'admin']), now, tz, random)
    quizzes++

    setSetting(db, DEMO_SEEDED_AT, now.toISOString())
    return { employees: employees.length, templates: TEMPLATES.length, instances, courses: COURSES.length, quizzes }
  })()
}

function ensurePositions(db: Db): Record<DemoEmployee['position'], Position> {
  const names: Record<DemoEmployee['position'], string> = { cook: 'Повар', admin: 'Администратор', barista: 'Бариста' }
  const existing = listPositions(db)
  const out = {} as Record<DemoEmployee['position'], Position>
  for (const key of Object.keys(names) as DemoEmployee['position'][]) {
    out[key] = existing.find((p) => p.name === names[key]) ?? createPosition(db, names[key])
  }
  return out
}

type Seeded = DemoEmployee & { row: Employee }

function ensureEmployees(db: Db, positions: Record<DemoEmployee['position'], Position>): Seeded[] {
  return EMPLOYEES.map((e) => {
    let row = findEmployeeByPhone(db, e.phone)
    if (!row) {
      row = createEmployee(db, { full_name: e.full_name, phone: e.phone, position_id: positions[e.position].id })
      if (e.telegram !== null) row = linkTelegram(db, row.id, e.telegram) ?? row
    }
    return { ...e, row }
  })
}

const pick = <T>(random: () => number, items: T[]): T => items[Math.floor(random() * items.length)]!

/** Все слоты расписания за последние DAYS_BACK дней до текущего момента. */
function pastSlots(schedule: Schedule, now: Date, tz: string): Date[] {
  const today = localParts(now, tz)
  const out: Date[] = []
  for (let offset = -DAYS_BACK; offset <= 0; offset++) {
    const day = addDays(today, offset)
    const weekday = ((((today.weekday - 1 + offset) % 7) + 7) % 7) + 1
    for (const slot of slotsForDay(schedule, weekday)) {
      const [hh, mm] = slot.split(':').map(Number)
      const at = zonedToUtc({ ...day, hh: hh!, mm: mm! }, tz)
      if (at.getTime() < now.getTime()) out.push(at)
    }
  }
  return out
}

function seedInstance(db: Db, templateId: number, e: Seeded, slot: Date, t: DemoTemplate, now: Date, random: () => number): void {
  const due = new Date(slot.getTime() + t.deadline_minutes * 60_000)
  const inst = createInstance(db, {
    template_id: templateId, employee_id: e.row.id, slot_at: slot.toISOString(), issued_at: slot.toISOString(), due_at: due.toISOString(), status: 'pending',
  })
  if (!inst) return
  if (due.getTime() > now.getTime()) return // ещё идёт
  const r = random()
  if (r < e.profile.onTime) {
    const done = new Date(slot.getTime() + random() * (t.deadline_minutes - 5) * 60_000)
    accept(db, inst.id, done, t, random, false)
  } else if (r < e.profile.onTime + e.profile.late) {
    const done = new Date(due.getTime() + (10 + random() * 90) * 60_000)
    accept(db, inst.id, done, t, random, true)
  } else {
    setInstanceStatus(db, inst.id, 'overdue')
  }
}

function accept(db: Db, instanceId: number, doneAt: Date, t: DemoTemplate, random: () => number, late: boolean): void {
  const iso = doneAt.toISOString()
  if (t.requires_photo) {
    const s = createSubmission(db, instanceId, iso, [])
    const score = 55 + Math.floor(random() * 45)
    if (score >= t.auto_accept_threshold && !late) {
      saveAiResult(db, s.id, { score, verdict: 'Всё по критериям, замечаний нет.', issues: [] }, 'auto_accepted', iso)
    } else {
      saveAiResult(db, s.id, { score, verdict: 'Есть замечания, нужна проверка владельца.', issues: ['Не всё видно на фото'] }, 'needs_review', iso)
      setOwnerDecision(db, s.id, 'owner_accepted', late ? 'Принято, но в следующий раз вовремя.' : null, new Date(doneAt.getTime() + HOUR).toISOString())
    }
  }
  setInstanceStatus(db, instanceId, 'accepted', { completed_at: iso })
}

function daysAgo(now: Date, days: number, hours = 0): Date {
  return new Date(now.getTime() - days * 24 * HOUR + hours * HOUR)
}

function takeQuiz(db: Db, assignmentId: number, quiz: Quiz, startedAt: Date, wrong: number): { score: number; passed: boolean } {
  const questions = listQuestions(db, quiz.id)
  const attempt = createAttempt(db, assignmentId, startedAt.toISOString())
  const answers = questions.map((q, i) => (i < wrong ? (q.correct_index + 1) % q.options.length : q.correct_index))
  answers.forEach((a, i) => recordAnswer(db, attempt.id, i + 1, a))
  const { score } = scoreAnswers(answers, questions)
  const passed = score >= quiz.pass_score
  finishAttempt(db, attempt.id, score, passed, new Date(startedAt.getTime() + 4 * 60_000).toISOString())
  if (passed) markQuizPassed(db, assignmentId, new Date(startedAt.getTime() + 4 * 60_000).toISOString())
  return { score, passed }
}

function seedCourse(db: Db, c: DemoCourse, positions: Record<DemoEmployee['position'], Position>, learners: Seeded[], now: Date, random: () => number): void {
  const publishedAt = daysAgo(now, c.publishedDaysAgo)
  const course = createCourse(db, { title: c.title, description: c.description, due_days: c.due_days, pass_score: 80, position_ids: c.positions.map((p) => positions[p].id) })
  replaceLessons(db, course.id, c.lessons.map((l) => ({ ...l, media: [] })))
  const quiz = createQuiz(db, { title: `Итоговый тест: ${c.title}`, course_id: course.id, pass_score: 80, schedule: null, deadline_minutes: null, position_ids: [] }, null)
  replaceQuestions(db, quiz.id, c.questions)
  setQuizStatus(db, quiz.id, 'published', null)
  publishCourse(db, course.id, true, publishedAt.toISOString())

  learners.forEach((e, i) => {
    const outcome = c.outcomes[i] ?? 'pass'
    // Ещё проходящий ученик получил курс недавно, остальные — в момент публикации.
    const assignedAt = outcome === 'in_progress' ? daysAgo(now, 2) : publishedAt
    const dueAt = new Date(assignedAt.getTime() + c.due_days * 24 * HOUR)
    const a = createCourseAssignment(db, { course_id: course.id, employee_id: e.row.id, assigned_at: assignedAt.toISOString(), due_at: dueAt.toISOString() })
    if (!a) return
    const qa = createQuizAssignment(db, {
      quiz_id: quiz.id, employee_id: e.row.id, course_assignment_id: a.id, slot_at: assignedAt.toISOString(), assigned_at: assignedAt.toISOString(), due_at: dueAt.toISOString(),
    })
    if (!qa) return
    if (outcome === 'pass' || outcome === 'retry') {
      db.prepare('update course_assignments set current_lesson = ? where id = ?').run(c.lessons.length + 1, a.id)
      const day1 = new Date(assignedAt.getTime() + (1 + random() * 2) * 24 * HOUR)
      if (outcome === 'retry') takeQuiz(db, qa.id, quiz, day1, 1)
      const day2 = new Date(day1.getTime() + (outcome === 'retry' ? 1 : 0) * 24 * HOUR)
      takeQuiz(db, qa.id, quiz, day2, 0)
      completeCourseAssignment(db, a.id, new Date(day2.getTime() + 5 * 60_000).toISOString())
    } else {
      db.prepare('update course_assignments set current_lesson = 2 where id = ?').run(a.id)
      if (outcome === 'overdue') setCourseAssignmentStatus(db, a.id, 'overdue')
    }
  })
}

function seedMenuQuiz(db: Db, positions: Record<DemoEmployee['position'], Position>, takers: Seeded[], now: Date, tz: string, random: () => number): void {
  const quiz = createQuiz(db, {
    title: 'Меню недели', course_id: null, pass_score: 80, schedule: MENU_QUIZ.schedule, deadline_minutes: 480,
    position_ids: [positions.barista.id, positions.admin.id],
  }, null)
  replaceQuestions(db, quiz.id, MENU_QUIZ.questions)
  setQuizStatus(db, quiz.id, 'published', nextRun(MENU_QUIZ.schedule, now, tz).toISOString())

  const slots = pastSlots(MENU_QUIZ.schedule, now, tz)
  slots.forEach((slot, si) => {
    const due = new Date(slot.getTime() + 480 * 60_000)
    takers.forEach((e, ei) => {
      const qa = createQuizAssignment(db, {
        quiz_id: quiz.id, employee_id: e.row.id, course_assignment_id: null, slot_at: slot.toISOString(), assigned_at: slot.toISOString(), due_at: due.toISOString(),
      })
      if (!qa) return
      const lastSlot = si === slots.length - 1
      const skips = lastSlot && ei === takers.length - 1 // последний слот последний участник не открыл
      if (skips) {
        if (due.getTime() < now.getTime()) setQuizAssignmentStatus(db, qa.id, 'overdue')
        return
      }
      const start = new Date(slot.getTime() + random() * 3 * HOUR)
      const wrong = random() < 0.25 ? 1 : 0
      const first = takeQuiz(db, qa.id, quiz, start, wrong)
      if (!first.passed && random() < 0.5) takeQuiz(db, qa.id, quiz, new Date(start.getTime() + HOUR), 0)
    })
  })
}
