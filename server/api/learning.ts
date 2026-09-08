import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import {
  createCourse, getCourse, listCourses, listLessons, publishCourse, replaceLessons, setCourseStatus, updateCourse, type Course, type CourseInput,
} from '../db/courses.js'
import {
  createQuiz, getCourseQuiz, getQuiz, listQuestions, listQuizzes, replaceQuestions, setQuizStatus, updateQuiz, type Quiz,
} from '../db/quizzes.js'
import { listAttempts, listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { idParams, parse } from '../lib/validate.js'
import type { Notifier } from '../notify.js'
import { assignCourse, issueQuiz } from '../learning/assign.js'
import { nextRun, scheduleSchema } from '../tasks/schedule.js'

type Opts = { db: Db; notifier: Notifier; tz: string; uploadsDir: string; now?: () => Date }

const media = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), path: z.string().regex(/^lessons\/\d{4}-\d{2}\/[a-f0-9]{16}\.(jpg|png|webp)$/, 'Недопустимый путь картинки') }),
  z.object({ kind: z.literal('video'), url: z.string().url().max(500) }),
])
const lesson = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().max(5000).default(''), media: z.array(media).default([]) })
const question = z
  .object({ text: z.string().trim().min(1).max(500), options: z.array(z.string().trim().min(1).max(200)).min(2).max(5), correct_index: z.number().int().min(0).max(4) })
  .refine((q) => q.correct_index < q.options.length, { message: 'Правильный ответ должен быть одним из вариантов', path: ['correct_index'] })

const courseBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  due_days: z.number().int().min(1).max(365),
  pass_score: z.number().int().min(0).max(100).default(80),
  position_ids: z.array(z.number().int().positive()).default([]),
  lessons: z.array(lesson).default([]),
  questions: z.array(question).default([]),
})
const publishBody = z.object({ assign_existing: z.boolean() })
const weeklyOnly = scheduleSchema.refine((s) => s.kind === 'weekly', { message: 'Для тестов доступно только расписание по дням недели' })
const quizBody = z.object({
  title: z.string().trim().min(1).max(200),
  pass_score: z.number().int().min(0).max(100).default(80),
  position_ids: z.array(z.number().int().positive()).default([]),
  schedule: weeklyOnly.nullable(),
  deadline_minutes: z.number().int().min(15),
  questions: z.array(question).default([]),
})
const uploadBody = z.object({
  filename: z.string().min(1).max(200),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(1),
})
const listQuery = z.object({ includeArchived: z.string().optional() })
const courseAssignmentsQuery = z.object({
  course_id: z.coerce.number().int().positive().optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['in_progress', 'completed', 'overdue']).optional(),
})
const quizAssignmentsQuery = z.object({
  quiz_id: z.coerce.number().int().positive().optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'passed', 'overdue']).optional(),
})

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_IMAGE = 5 * 1024 * 1024

export const learningRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, notifier, tz, uploadsDir } = opts
  const now = opts.now ?? (() => new Date())
  const learningDeps = { db, notifier, tz }

  function courseDetails(course: Course) {
    const quiz = getCourseQuiz(db, course.id)
    return { course, lessons: listLessons(db, course.id), quiz, questions: quiz ? listQuestions(db, quiz.id) : [] }
  }

  function saveCourseParts(course: Course, body: z.infer<typeof courseBody>): void {
    replaceLessons(db, course.id, body.lessons)
    const quiz =
      getCourseQuiz(db, course.id) ??
      createQuiz(db, { title: `Итоговый тест: ${course.title}`, course_id: course.id, pass_score: body.pass_score, schedule: null, deadline_minutes: null, position_ids: [] }, null)
    updateQuiz(db, quiz.id, { title: `Итоговый тест: ${course.title}`, course_id: course.id, pass_score: body.pass_score, schedule: null, deadline_minutes: null, position_ids: [] }, null)
    replaceQuestions(db, quiz.id, body.questions)
  }

  function courseIssues(course: Course): string[] {
    const issues: string[] = []
    if (course.position_ids.length === 0) issues.push('Выберите хотя бы одну должность')
    if (course.lesson_count === 0) issues.push('Добавьте хотя бы один урок')
    const quiz = getCourseQuiz(db, course.id)
    if (!quiz || quiz.question_count === 0) issues.push('Добавьте хотя бы один вопрос в итоговый тест')
    return issues
  }

  app.get('/api/learning/courses', async (req) => {
    const q = parse(listQuery, req.query)
    return listCourses(db, { includeArchived: q.includeArchived === '1' })
  })

  app.get('/api/learning/courses/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const course = getCourse(db, id)
    return course ? courseDetails(course) : reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/learning/courses', async (req, reply) => {
    const body = parse(courseBody, req.body)
    const input: CourseInput = { title: body.title, description: body.description, due_days: body.due_days, pass_score: body.pass_score, position_ids: body.position_ids }
    const course = db.transaction(() => {
      const c = createCourse(db, input)
      saveCourseParts(c, body)
      return getCourse(db, c.id)!
    })()
    return reply.code(201).send(courseDetails(course))
  })

  app.patch('/api/learning/courses/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const body = parse(courseBody, req.body)
    const input: CourseInput = { title: body.title, description: body.description, due_days: body.due_days, pass_score: body.pass_score, position_ids: body.position_ids }
    const course = db.transaction(() => {
      const c = updateCourse(db, id, input)
      if (!c) return null
      saveCourseParts(c, body)
      return getCourse(db, id)
    })()
    return course ? courseDetails(course) : reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/learning/courses/:id/publish', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const { assign_existing } = parse(publishBody, req.body)
    const course = getCourse(db, id)
    if (!course) return reply.code(404).send({ error: 'not_found' })
    const issues = courseIssues(course)
    if (issues.length) return reply.code(409).send({ error: 'incomplete', issues })
    const t = now()
    const published = publishCourse(db, id, assign_existing, t.toISOString())!
    const assigned = assign_existing ? await assignCourse(learningDeps, published, t, false) : 0
    return { course: getCourse(db, id), assigned }
  })

  app.post('/api/learning/courses/:id/archive', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return setCourseStatus(db, id, 'archived') ?? reply.code(404).send({ error: 'not_found' })
  })

  const quizDetails = (quiz: Quiz) => ({ quiz, questions: listQuestions(db, quiz.id) })
  const quizNextRun = (quiz: { schedule: Quiz['schedule']; status: Quiz['status'] }) =>
    quiz.schedule && quiz.status === 'published' ? nextRun(quiz.schedule, now(), tz).toISOString() : null

  app.get('/api/learning/quizzes', async (req) => {
    const q = parse(listQuery, req.query)
    return listQuizzes(db, { includeArchived: q.includeArchived === '1' })
  })

  app.get('/api/learning/quizzes/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const quiz = getQuiz(db, id)
    return quiz && quiz.course_id === null ? quizDetails(quiz) : reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/learning/quizzes', async (req, reply) => {
    const body = parse(quizBody, req.body)
    const quiz = db.transaction(() => {
      const q = createQuiz(db, { title: body.title, course_id: null, pass_score: body.pass_score, schedule: body.schedule, deadline_minutes: body.deadline_minutes, position_ids: body.position_ids }, null)
      replaceQuestions(db, q.id, body.questions)
      return getQuiz(db, q.id)!
    })()
    return reply.code(201).send(quizDetails(quiz))
  })

  app.patch('/api/learning/quizzes/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const body = parse(quizBody, req.body)
    const current = getQuiz(db, id)
    if (!current || current.course_id !== null) return reply.code(404).send({ error: 'not_found' })
    const quiz = db.transaction(() => {
      const q = updateQuiz(db, id, { title: body.title, course_id: null, pass_score: body.pass_score, schedule: body.schedule, deadline_minutes: body.deadline_minutes, position_ids: body.position_ids }, quizNextRun({ schedule: body.schedule, status: current.status }))!
      replaceQuestions(db, q.id, body.questions)
      return getQuiz(db, id)!
    })()
    return quizDetails(quiz)
  })

  app.post('/api/learning/quizzes/:id/publish', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const quiz = getQuiz(db, id)
    if (!quiz || quiz.course_id !== null) return reply.code(404).send({ error: 'not_found' })
    const issues: string[] = []
    if (quiz.position_ids.length === 0) issues.push('Выберите хотя бы одну должность')
    if (quiz.question_count === 0) issues.push('Добавьте хотя бы один вопрос')
    if (issues.length) return reply.code(409).send({ error: 'incomplete', issues })
    return setQuizStatus(db, id, 'published', quizNextRun({ schedule: quiz.schedule, status: 'published' }))
  })

  app.post('/api/learning/quizzes/:id/issue', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const quiz = getQuiz(db, id)
    if (!quiz || quiz.course_id !== null) return reply.code(404).send({ error: 'not_found' })
    if (quiz.status !== 'published') return reply.code(409).send({ error: 'not_published' })
    const t = now()
    return { assigned: await issueQuiz(learningDeps, quiz, t, t) }
  })

  app.post('/api/learning/quizzes/:id/archive', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    return setQuizStatus(db, id, 'archived', null) ?? reply.code(404).send({ error: 'not_found' })
  })

  app.get('/api/learning/assignments/courses', async (req) => listCourseAssignments(db, parse(courseAssignmentsQuery, req.query)))
  app.get('/api/learning/assignments/quizzes', async (req) => listQuizAssignments(db, parse(quizAssignmentsQuery, req.query)))
  app.get('/api/learning/assignments/quizzes/:id/attempts', async (req) => {
    const { id } = parse(idParams, req.params)
    return listAttempts(db, id)
  })

  app.post('/api/learning/upload', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(uploadBody, req.body)
    const data = Buffer.from(body.data, 'base64')
    if (data.length === 0 || data.length > MAX_IMAGE) return reply.code(400).send({ error: 'validation', issues: [{ message: 'Картинка до 5 МБ' }] })
    const month = now().toISOString().slice(0, 7)
    const rel = join('lessons', month, `${randomBytes(8).toString('hex')}.${EXT[body.mime]}`)
    mkdirSync(join(uploadsDir, 'lessons', month), { recursive: true })
    writeFileSync(join(uploadsDir, rel), data)
    return reply.code(201).send({ path: rel })
  })
}
