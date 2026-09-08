import type { Db } from './connect.js'

export type Decision = 'auto_accepted' | 'needs_review' | 'owner_accepted' | 'owner_rejected'
export type AiStatus = 'pending' | 'done' | 'failed'

export type Submission = {
  id: number
  instance_id: number
  created_at: string
  ai_status: AiStatus
  ai_attempts: number
  ai_score: number | null
  ai_verdict: string | null
  ai_issues: string[]
  decision: Decision | null
  owner_comment: string | null
  decided_at: string | null
}

export type Photo = {
  id: number
  submission_id: number
  position: number
  path: string
  telegram_file_unique_id: string
  deleted_at: string | null
}

export type ReviewRow = Submission & {
  template_id: number
  title: string
  photo_criteria: string | null
  employee_id: number
  employee_name: string
  photos: Photo[]
}

type Raw = Omit<Submission, 'ai_issues'> & { ai_issues: string }
const cols = 's.id, s.instance_id, s.created_at, s.ai_status, s.ai_attempts, s.ai_score, s.ai_verdict, s.ai_issues, s.decision, s.owner_comment, s.decided_at'
const hydrate = (r: Raw): Submission => ({ ...r, ai_issues: JSON.parse(r.ai_issues) as string[] })

export function createSubmission(db: Db, instanceId: number, nowIso: string, photos: { path: string; fileUniqueId: string }[]): Submission {
  return db.transaction(() => {
    const info = db.prepare('insert into task_submissions (instance_id, created_at) values (?, ?)').run(instanceId, nowIso)
    const id = Number(info.lastInsertRowid)
    const ins = db.prepare('insert into task_photos (submission_id, position, path, telegram_file_unique_id) values (?, ?, ?, ?)')
    photos.forEach((p, i) => ins.run(id, i + 1, p.path, p.fileUniqueId))
    return getSubmission(db, id)!
  })()
}

export function getSubmission(db: Db, id: number): Submission | null {
  const r = db.prepare(`select ${cols} from task_submissions s where s.id = ?`).get(id) as Raw | undefined
  return r ? hydrate(r) : null
}

export function listPhotos(db: Db, submissionId: number): Photo[] {
  return db.prepare('select * from task_photos where submission_id = ? order by position').all(submissionId) as Photo[]
}

export function photoExists(db: Db, fileUniqueId: string): boolean {
  return db.prepare('select 1 from task_photos where telegram_file_unique_id = ?').get(fileUniqueId) !== undefined
}

export function listSubmissionsForInstance(db: Db, instanceId: number): (Submission & { photos: Photo[] })[] {
  const rows = db.prepare(`select ${cols} from task_submissions s where s.instance_id = ? order by s.id`).all(instanceId) as Raw[]
  return rows.map((r) => ({ ...hydrate(r), photos: listPhotos(db, r.id) }))
}

export function markAiStarted(db: Db, id: number): void {
  db.prepare('update task_submissions set ai_attempts = ai_attempts + 1 where id = ?').run(id)
}

export function saveAiResult(
  db: Db, id: number, r: { score: number; verdict: string; issues: string[] },
  decision: 'auto_accepted' | 'needs_review', nowIso: string,
): void {
  db.prepare(
    `update task_submissions set ai_status = 'done', ai_score = ?, ai_verdict = ?, ai_issues = ?, decision = ?, decided_at = case when ? = 'auto_accepted' then ? else null end where id = ?`,
  ).run(r.score, r.verdict, JSON.stringify(r.issues), decision, decision, nowIso, id)
}

export function markAiFailed(db: Db, id: number, _nowIso: string): void {
  db.prepare("update task_submissions set ai_status = 'failed', decision = 'needs_review' where id = ?").run(id)
}

export function setOwnerDecision(db: Db, id: number, decision: 'owner_accepted' | 'owner_rejected', comment: string | null, nowIso: string): boolean {
  const info = db
    .prepare("update task_submissions set decision = ?, owner_comment = ?, decided_at = ? where id = ? and decision = 'needs_review'")
    .run(decision, comment, nowIso, id)
  return info.changes === 1
}

const reviewSelect = `select ${cols}, i.template_id, t.title, t.photo_criteria, i.employee_id, e.full_name as employee_name
  from task_submissions s join task_instances i on i.id = s.instance_id join task_templates t on t.id = i.template_id join employees e on e.id = i.employee_id`

type RawReview = Raw & { template_id: number; title: string; photo_criteria: string | null; employee_id: number; employee_name: string }
const hydrateReview = (db: Db, r: RawReview): ReviewRow => ({ ...r, ai_issues: JSON.parse(r.ai_issues) as string[], photos: listPhotos(db, r.id) })

export function listReviewQueue(db: Db): ReviewRow[] {
  const rows = db.prepare(`${reviewSelect} where s.decision = 'needs_review' order by s.created_at`).all() as RawReview[]
  return rows.map((r) => hydrateReview(db, r))
}

export function getReviewRow(db: Db, submissionId: number): ReviewRow | null {
  const r = db.prepare(`${reviewSelect} where s.id = ?`).get(submissionId) as RawReview | undefined
  return r ? hydrateReview(db, r) : null
}

export function listStaleAiPending(db: Db, beforeIso: string): Submission[] {
  const rows = db.prepare(`select ${cols} from task_submissions s where s.ai_status = 'pending' and s.created_at < ? order by s.id`).all(beforeIso) as Raw[]
  return rows.map(hydrate)
}

export function listPhotosOlderThan(db: Db, beforeIso: string): Photo[] {
  return db
    .prepare('select p.* from task_photos p join task_submissions s on s.id = p.submission_id where p.deleted_at is null and s.created_at < ? order by p.id')
    .all(beforeIso) as Photo[]
}

export function markPhotoDeleted(db: Db, id: number, nowIso: string): void {
  db.prepare('update task_photos set deleted_at = ? where id = ?').run(nowIso, id)
}
