import type { Db } from './connect.js'

export type CourseStatus = 'draft' | 'published' | 'archived'
export type Media = { kind: 'image'; path: string } | { kind: 'video'; url: string }
export type Lesson = { id: number; course_id: number; position: number; title: string; body: string; media: Media[] }
export type LessonInput = { title: string; body: string; media: Media[] }

export type Course = {
  id: number
  title: string
  description: string
  due_days: number
  pass_score: number
  status: CourseStatus
  published_at: string | null
  assign_existing: boolean
  created_at: string
  position_ids: number[]
  lesson_count: number
}
export type CourseInput = { title: string; description: string; due_days: number; pass_score: number; position_ids: number[] }

type Row = Omit<Course, 'assign_existing' | 'position_ids' | 'lesson_count'> & { assign_existing: number; lesson_count: number }
const cols = `c.id, c.title, c.description, c.due_days, c.pass_score, c.status, c.published_at, c.assign_existing, c.created_at,
  (select count(*) from lessons l where l.course_id = c.id) as lesson_count`

function hydrate(db: Db, r: Row): Course {
  const position_ids = (db.prepare('select position_id from course_positions where course_id = ? order by position_id').all(r.id) as { position_id: number }[]).map((x) => x.position_id)
  return { ...r, assign_existing: r.assign_existing === 1, position_ids }
}

function writePositions(db: Db, id: number, ids: number[]): void {
  db.prepare('delete from course_positions where course_id = ?').run(id)
  const ins = db.prepare('insert into course_positions (course_id, position_id) values (?, ?)')
  for (const p of ids) ins.run(id, p)
}

export function getCourse(db: Db, id: number): Course | null {
  const r = db.prepare(`select ${cols} from courses c where c.id = ?`).get(id) as Row | undefined
  return r ? hydrate(db, r) : null
}

export function createCourse(db: Db, input: CourseInput): Course {
  return db.transaction(() => {
    const info = db
      .prepare('insert into courses (title, description, due_days, pass_score) values (?, ?, ?, ?)')
      .run(input.title, input.description, input.due_days, input.pass_score)
    const id = Number(info.lastInsertRowid)
    writePositions(db, id, input.position_ids)
    return getCourse(db, id)!
  })()
}

export function updateCourse(db: Db, id: number, input: CourseInput): Course | null {
  return db.transaction(() => {
    const info = db
      .prepare('update courses set title = ?, description = ?, due_days = ?, pass_score = ? where id = ?')
      .run(input.title, input.description, input.due_days, input.pass_score, id)
    if (info.changes === 0) return null
    writePositions(db, id, input.position_ids)
    return getCourse(db, id)
  })()
}

export function listCourses(db: Db, opts: { includeArchived?: boolean } = {}): Course[] {
  const where = opts.includeArchived ? '' : "where c.status != 'archived'"
  return (db.prepare(`select ${cols} from courses c ${where} order by c.title`).all() as Row[]).map((r) => hydrate(db, r))
}

export function listPublishedCourses(db: Db): Course[] {
  return (db.prepare(`select ${cols} from courses c where c.status = 'published' order by c.id`).all() as Row[]).map((r) => hydrate(db, r))
}

export function publishCourse(db: Db, id: number, assignExisting: boolean, nowIso: string): Course | null {
  const info = db
    .prepare("update courses set status = 'published', published_at = ?, assign_existing = ? where id = ?")
    .run(nowIso, assignExisting ? 1 : 0, id)
  return info.changes === 0 ? null : getCourse(db, id)
}

export function setCourseStatus(db: Db, id: number, status: CourseStatus): Course | null {
  const info = db.prepare('update courses set status = ? where id = ?').run(status, id)
  return info.changes === 0 ? null : getCourse(db, id)
}

type LessonRow = Omit<Lesson, 'media'> & { media: string }
const lessonCols = 'id, course_id, position, title, body, media'
const toLesson = (r: LessonRow): Lesson => ({ ...r, media: JSON.parse(r.media) as Media[] })

export function replaceLessons(db: Db, courseId: number, lessons: LessonInput[]): void {
  db.transaction(() => {
    db.prepare('delete from lessons where course_id = ?').run(courseId)
    const ins = db.prepare('insert into lessons (course_id, position, title, body, media) values (?, ?, ?, ?, ?)')
    lessons.forEach((l, i) => ins.run(courseId, i + 1, l.title, l.body, JSON.stringify(l.media)))
  })()
}

export function listLessons(db: Db, courseId: number): Lesson[] {
  return (db.prepare(`select ${lessonCols} from lessons where course_id = ? order by position`).all(courseId) as LessonRow[]).map(toLesson)
}

export function getLesson(db: Db, courseId: number, position: number): Lesson | null {
  const r = db.prepare(`select ${lessonCols} from lessons where course_id = ? and position = ?`).get(courseId, position) as LessonRow | undefined
  return r ? toLesson(r) : null
}
