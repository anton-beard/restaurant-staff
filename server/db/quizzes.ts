import type { Db } from './connect.js'
import type { Schedule } from '../tasks/schedule.js'

export type QuizStatus = 'draft' | 'published' | 'archived'
export type Question = { id: number; quiz_id: number; position: number; text: string; options: string[]; correct_index: number }
export type QuestionInput = { text: string; options: string[]; correct_index: number }

export type Quiz = {
  id: number
  title: string
  course_id: number | null
  pass_score: number
  schedule: Schedule | null
  deadline_minutes: number | null
  status: QuizStatus
  next_run_at: string | null
  created_at: string
  position_ids: number[]
  question_count: number
}
export type QuizInput = {
  title: string
  course_id: number | null
  pass_score: number
  schedule: Schedule | null
  deadline_minutes: number | null
  position_ids: number[]
}

type Row = Omit<Quiz, 'schedule' | 'position_ids'> & { schedule: string | null }
const cols = `q.id, q.title, q.course_id, q.pass_score, q.schedule, q.deadline_minutes, q.status, q.next_run_at, q.created_at,
  (select count(*) from questions x where x.quiz_id = q.id) as question_count`

function hydrate(db: Db, r: Row): Quiz {
  const position_ids = (db.prepare('select position_id from quiz_positions where quiz_id = ? order by position_id').all(r.id) as { position_id: number }[]).map((x) => x.position_id)
  return { ...r, schedule: r.schedule ? (JSON.parse(r.schedule) as Schedule) : null, position_ids }
}

function writePositions(db: Db, id: number, ids: number[]): void {
  db.prepare('delete from quiz_positions where quiz_id = ?').run(id)
  const ins = db.prepare('insert into quiz_positions (quiz_id, position_id) values (?, ?)')
  for (const p of ids) ins.run(id, p)
}

export function getQuiz(db: Db, id: number): Quiz | null {
  const r = db.prepare(`select ${cols} from quizzes q where q.id = ?`).get(id) as Row | undefined
  return r ? hydrate(db, r) : null
}

export function getCourseQuiz(db: Db, courseId: number): Quiz | null {
  const r = db.prepare(`select ${cols} from quizzes q where q.course_id = ?`).get(courseId) as Row | undefined
  return r ? hydrate(db, r) : null
}

export function createQuiz(db: Db, input: QuizInput, nextRunAt: string | null): Quiz {
  return db.transaction(() => {
    const info = db
      .prepare('insert into quizzes (title, course_id, pass_score, schedule, deadline_minutes, next_run_at) values (?, ?, ?, ?, ?, ?)')
      .run(input.title, input.course_id, input.pass_score, input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt)
    const id = Number(info.lastInsertRowid)
    writePositions(db, id, input.position_ids)
    return getQuiz(db, id)!
  })()
}

export function updateQuiz(db: Db, id: number, input: QuizInput, nextRunAt: string | null): Quiz | null {
  return db.transaction(() => {
    const info = db
      .prepare('update quizzes set title = ?, course_id = ?, pass_score = ?, schedule = ?, deadline_minutes = ?, next_run_at = ? where id = ?')
      .run(input.title, input.course_id, input.pass_score, input.schedule ? JSON.stringify(input.schedule) : null, input.deadline_minutes, nextRunAt, id)
    if (info.changes === 0) return null
    writePositions(db, id, input.position_ids)
    return getQuiz(db, id)
  })()
}

export function listQuizzes(db: Db, opts: { includeArchived?: boolean } = {}): Quiz[] {
  const where = opts.includeArchived ? '' : "and q.status != 'archived'"
  return (db.prepare(`select ${cols} from quizzes q where q.course_id is null ${where} order by q.title`).all() as Row[]).map((r) => hydrate(db, r))
}

export function setQuizStatus(db: Db, id: number, status: QuizStatus, nextRunAt: string | null): Quiz | null {
  const info = db.prepare('update quizzes set status = ?, next_run_at = ? where id = ?').run(status, nextRunAt, id)
  return info.changes === 0 ? null : getQuiz(db, id)
}

export function setQuizNextRunAt(db: Db, id: number, iso: string | null): void {
  db.prepare('update quizzes set next_run_at = ? where id = ?').run(iso, id)
}

export function listDueQuizzes(db: Db, nowIso: string): Quiz[] {
  return (
    db
      .prepare(`select ${cols} from quizzes q where q.status = 'published' and q.course_id is null and q.schedule is not null and q.next_run_at is not null and q.next_run_at <= ? order by q.next_run_at`)
      .all(nowIso) as Row[]
  ).map((r) => hydrate(db, r))
}

type QuestionRow = Omit<Question, 'options'> & { options: string }
const toQuestion = (r: QuestionRow): Question => ({ ...r, options: JSON.parse(r.options) as string[] })

export function replaceQuestions(db: Db, quizId: number, questions: QuestionInput[]): void {
  db.transaction(() => {
    db.prepare('delete from questions where quiz_id = ?').run(quizId)
    const ins = db.prepare('insert into questions (quiz_id, position, text, options, correct_index) values (?, ?, ?, ?, ?)')
    questions.forEach((q, i) => ins.run(quizId, i + 1, q.text, JSON.stringify(q.options), q.correct_index))
  })()
}

export function listQuestions(db: Db, quizId: number): Question[] {
  return (db.prepare('select id, quiz_id, position, text, options, correct_index from questions where quiz_id = ? order by position').all(quizId) as QuestionRow[]).map(toQuestion)
}
