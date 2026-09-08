import type { Db } from './connect.js'

export type CourseAssignmentStatus = 'in_progress' | 'completed' | 'overdue'
export type CourseAssignment = {
  id: number
  course_id: number
  employee_id: number
  assigned_at: string
  due_at: string
  current_lesson: number
  status: CourseAssignmentStatus
  completed_at: string | null
  reminder_sent_at: string | null
}
export type CourseAssignmentRow = CourseAssignment & { title: string; lesson_count: number; employee_name: string }

const caCols = 'a.id, a.course_id, a.employee_id, a.assigned_at, a.due_at, a.current_lesson, a.status, a.completed_at, a.reminder_sent_at'
const caRow = `select ${caCols}, c.title, (select count(*) from lessons l where l.course_id = c.id) as lesson_count, e.full_name as employee_name
  from course_assignments a join courses c on c.id = a.course_id join employees e on e.id = a.employee_id`

function uniqueOrNull<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null
    throw err
  }
}

export function createCourseAssignment(
  db: Db, i: { course_id: number; employee_id: number; assigned_at: string; due_at: string },
): CourseAssignment | null {
  return uniqueOrNull(() => {
    const info = db
      .prepare('insert into course_assignments (course_id, employee_id, assigned_at, due_at) values (?, ?, ?, ?)')
      .run(i.course_id, i.employee_id, i.assigned_at, i.due_at)
    return getCourseAssignment(db, Number(info.lastInsertRowid))!
  })
}

export function getCourseAssignment(db: Db, id: number): CourseAssignment | null {
  return (db.prepare(`select ${caCols} from course_assignments a where a.id = ?`).get(id) as CourseAssignment) ?? null
}

export function getCourseAssignmentRow(db: Db, id: number): CourseAssignmentRow | null {
  return (db.prepare(`${caRow} where a.id = ?`).get(id) as CourseAssignmentRow) ?? null
}

export function listEmployeeCourseAssignments(db: Db, employeeId: number): CourseAssignmentRow[] {
  return db.prepare(`${caRow} where a.employee_id = ? order by a.due_at`).all(employeeId) as CourseAssignmentRow[]
}

export function listCourseAssignments(db: Db, f: { course_id?: number; employee_id?: number; status?: CourseAssignmentStatus }): CourseAssignmentRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.course_id) { where.push('a.course_id = ?'); args.push(f.course_id) }
  if (f.employee_id) { where.push('a.employee_id = ?'); args.push(f.employee_id) }
  if (f.status) { where.push('a.status = ?'); args.push(f.status) }
  const sql = `${caRow} ${where.length ? 'where ' + where.join(' and ') : ''} order by a.assigned_at desc, a.id desc limit 500`
  return db.prepare(sql).all(...args) as CourseAssignmentRow[]
}

export function hasCourseAssignment(db: Db, courseId: number, employeeId: number): boolean {
  return db.prepare('select 1 from course_assignments where course_id = ? and employee_id = ?').get(courseId, employeeId) !== undefined
}

export function advanceLesson(db: Db, id: number, fromLesson: number): boolean {
  return db.prepare('update course_assignments set current_lesson = current_lesson + 1 where id = ? and current_lesson = ?').run(id, fromLesson).changes === 1
}

export function completeCourseAssignment(db: Db, id: number, nowIso: string): void {
  db.prepare("update course_assignments set status = 'completed', completed_at = ? where id = ?").run(nowIso, id)
}

export function setCourseAssignmentStatus(db: Db, id: number, status: CourseAssignmentStatus): void {
  db.prepare('update course_assignments set status = ? where id = ?').run(status, id)
}

export function listCourseReminderCandidates(db: Db, nowIso: string): CourseAssignment[] {
  return db.prepare(`select ${caCols} from course_assignments a where a.status = 'in_progress' and a.reminder_sent_at is null and a.due_at > ? order by a.due_at`).all(nowIso) as CourseAssignment[]
}

export function markCourseReminderSent(db: Db, id: number, nowIso: string): void {
  db.prepare('update course_assignments set reminder_sent_at = ? where id = ?').run(nowIso, id)
}

export function listCourseOverdueCandidates(db: Db, nowIso: string): CourseAssignment[] {
  return db.prepare(`select ${caCols} from course_assignments a where a.status = 'in_progress' and a.due_at < ? order by a.due_at`).all(nowIso) as CourseAssignment[]
}

export type QuizAssignmentStatus = 'pending' | 'passed' | 'overdue'
export type QuizAssignment = {
  id: number
  quiz_id: number
  employee_id: number
  course_assignment_id: number | null
  slot_at: string
  assigned_at: string
  due_at: string
  status: QuizAssignmentStatus
  passed_at: string | null
  reminder_sent_at: string | null
}
export type QuizAssignmentRow = QuizAssignment & { title: string; employee_name: string; open_attempt_id: number | null; course_id: number | null }

const qaCols = 'a.id, a.quiz_id, a.employee_id, a.course_assignment_id, a.slot_at, a.assigned_at, a.due_at, a.status, a.passed_at, a.reminder_sent_at'
const qaRow = `select ${qaCols}, q.title, q.course_id, e.full_name as employee_name,
  (select t.id from quiz_attempts t where t.assignment_id = a.id and t.finished_at is null limit 1) as open_attempt_id
  from quiz_assignments a join quizzes q on q.id = a.quiz_id join employees e on e.id = a.employee_id`

export function createQuizAssignment(
  db: Db,
  i: { quiz_id: number; employee_id: number; course_assignment_id: number | null; slot_at: string; assigned_at: string; due_at: string },
): QuizAssignment | null {
  return uniqueOrNull(() => {
    const info = db
      .prepare('insert into quiz_assignments (quiz_id, employee_id, course_assignment_id, slot_at, assigned_at, due_at) values (?, ?, ?, ?, ?, ?)')
      .run(i.quiz_id, i.employee_id, i.course_assignment_id, i.slot_at, i.assigned_at, i.due_at)
    return getQuizAssignment(db, Number(info.lastInsertRowid))!
  })
}

export function getQuizAssignment(db: Db, id: number): QuizAssignment | null {
  return (db.prepare(`select ${qaCols} from quiz_assignments a where a.id = ?`).get(id) as QuizAssignment) ?? null
}

export function findQuizAssignmentForCourse(db: Db, courseAssignmentId: number): QuizAssignment | null {
  return (db.prepare(`select ${qaCols} from quiz_assignments a where a.course_assignment_id = ?`).get(courseAssignmentId) as QuizAssignment) ?? null
}

export function getQuizAssignmentRow(db: Db, id: number): QuizAssignmentRow | null {
  return (db.prepare(`${qaRow} where a.id = ?`).get(id) as QuizAssignmentRow) ?? null
}

export function listEmployeeQuizAssignments(db: Db, employeeId: number): QuizAssignmentRow[] {
  return db.prepare(`${qaRow} where a.employee_id = ? and a.status in ('pending', 'overdue') order by a.due_at`).all(employeeId) as QuizAssignmentRow[]
}

export function listQuizAssignments(db: Db, f: { quiz_id?: number; employee_id?: number; status?: QuizAssignmentStatus }): QuizAssignmentRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.quiz_id) { where.push('a.quiz_id = ?'); args.push(f.quiz_id) }
  if (f.employee_id) { where.push('a.employee_id = ?'); args.push(f.employee_id) }
  if (f.status) { where.push('a.status = ?'); args.push(f.status) }
  const sql = `${qaRow} ${where.length ? 'where ' + where.join(' and ') : ''} order by a.assigned_at desc, a.id desc limit 500`
  return db.prepare(sql).all(...args) as QuizAssignmentRow[]
}

export function markQuizPassed(db: Db, id: number, nowIso: string): void {
  db.prepare("update quiz_assignments set status = 'passed', passed_at = ? where id = ?").run(nowIso, id)
}

export function setQuizAssignmentStatus(db: Db, id: number, status: QuizAssignmentStatus): void {
  db.prepare('update quiz_assignments set status = ? where id = ?').run(status, id)
}

export function listQuizReminderCandidates(db: Db, nowIso: string): QuizAssignment[] {
  return db.prepare(`select ${qaCols} from quiz_assignments a where a.status = 'pending' and a.reminder_sent_at is null and a.due_at > ? order by a.due_at`).all(nowIso) as QuizAssignment[]
}

export function markQuizReminderSent(db: Db, id: number, nowIso: string): void {
  db.prepare('update quiz_assignments set reminder_sent_at = ? where id = ?').run(nowIso, id)
}

export function listQuizOverdueCandidates(db: Db, nowIso: string): QuizAssignment[] {
  return db.prepare(`select ${qaCols} from quiz_assignments a where a.status = 'pending' and a.due_at < ? order by a.due_at`).all(nowIso) as QuizAssignment[]
}

export type QuizAttempt = {
  id: number
  assignment_id: number
  started_at: string
  finished_at: string | null
  current_question: number
  answers: number[]
  score: number | null
  passed: boolean | null
}
type AttemptRow = Omit<QuizAttempt, 'answers' | 'passed'> & { answers: string; passed: number | null }
const atCols = 'id, assignment_id, started_at, finished_at, current_question, answers, score, passed'
const toAttempt = (r: AttemptRow): QuizAttempt => ({ ...r, answers: JSON.parse(r.answers) as number[], passed: r.passed === null ? null : r.passed === 1 })

export function getOpenAttempt(db: Db, assignmentId: number): QuizAttempt | null {
  const r = db.prepare(`select ${atCols} from quiz_attempts where assignment_id = ? and finished_at is null`).get(assignmentId) as AttemptRow | undefined
  return r ? toAttempt(r) : null
}

export function createAttempt(db: Db, assignmentId: number, nowIso: string): QuizAttempt {
  if (getOpenAttempt(db, assignmentId)) throw new Error('assignment already has an open attempt')
  const info = db.prepare('insert into quiz_attempts (assignment_id, started_at) values (?, ?)').run(assignmentId, nowIso)
  return getAttempt(db, Number(info.lastInsertRowid))!
}

export function getAttempt(db: Db, id: number): QuizAttempt | null {
  const r = db.prepare(`select ${atCols} from quiz_attempts where id = ?`).get(id) as AttemptRow | undefined
  return r ? toAttempt(r) : null
}

export function recordAnswer(db: Db, attemptId: number, questionPosition: number, optionIndex: number): boolean {
  return db.transaction(() => {
    const a = getAttempt(db, attemptId)
    if (!a || a.finished_at || a.current_question !== questionPosition) return false
    const answers = [...a.answers, optionIndex]
    db.prepare('update quiz_attempts set answers = ?, current_question = current_question + 1 where id = ?').run(JSON.stringify(answers), attemptId)
    return true
  })()
}

export function finishAttempt(db: Db, id: number, score: number, passed: boolean, nowIso: string): void {
  db.prepare('update quiz_attempts set finished_at = ?, score = ?, passed = ? where id = ?').run(nowIso, score, passed ? 1 : 0, id)
}

export function listAttempts(db: Db, assignmentId: number): QuizAttempt[] {
  return (db.prepare(`select ${atCols} from quiz_attempts where assignment_id = ? order by id`).all(assignmentId) as AttemptRow[]).map(toAttempt)
}
