import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/connect.js'
import { getEmployee } from '../db/employees.js'
import { setInstanceStatus } from '../db/taskInstances.js'
import { getTaskTemplate } from '../db/taskTemplates.js'
import { getReviewRow, getSubmission, listPhotos, markAiFailed, markAiStarted, saveAiResult } from '../db/taskSubmissions.js'
import type { Notifier } from '../notify.js'
import type { Reviewer } from '../ai/photoReview.js'
import { reviewKeyboard } from '../bot/keyboards.js'
import { decideByScore, ownerReviewCaption } from './decide.js'

export type ReviewQueue = { enqueue(submissionId: number): void; size(): number; idle(): Promise<void> }
export type ReviewQueueDeps = {
  db: Db
  notifier: Notifier
  tz: string
  uploadsDir: string
  reviewer: Reviewer
  concurrency?: number
  now?: () => Date
}

export function createReviewQueue(deps: ReviewQueueDeps): ReviewQueue {
  const { db, notifier, uploadsDir, reviewer } = deps
  const concurrency = deps.concurrency ?? 2
  const now = deps.now ?? (() => new Date())
  const waiting: number[] = []
  const active = new Set<number>()
  let running = 0
  let idleWaiters: (() => void)[] = []

  async function notifyEmployee(employeeId: number, text: string): Promise<void> {
    const e = getEmployee(db, employeeId)
    if (e?.telegram_id) await notifier.toEmployee(e.telegram_id, text)
  }

  async function process(submissionId: number): Promise<void> {
    const sub = getSubmission(db, submissionId)
    if (!sub || sub.decision !== null) return
    const row = getReviewRow(db, submissionId)
    const template = row ? getTaskTemplate(db, row.template_id) : null
    if (!row || !template) return
    const photos = listPhotos(db, submissionId).filter((p) => p.deleted_at === null)
    const paths = photos.map((p) => join(uploadsDir, p.path))
    if (paths.length === 0) {
      console.warn('photo review skipped: no photos on disk', submissionId)
      markAiFailed(db, submissionId, now().toISOString())
      setInstanceStatus(db, row.instance_id, 'review')
      await notifyEmployee(row.employee_id, 'Отправил владельцу на проверку.')
      const freshReview = getReviewRow(db, submissionId)!
      await notifier.toOwner(ownerReviewCaption(freshReview), { keyboard: reviewKeyboard(submissionId) })
      return
    }
    markAiStarted(db, submissionId)
    try {
      const result = await reviewer({
        photos: paths.map((p) => ({ data: readFileSync(p), mediaType: 'image/jpeg' as const })),
        title: template.title,
        description: template.description,
        criteria: template.photo_criteria ?? '',
      })
      const decision = decideByScore(result.score, template.auto_accept_threshold)
      saveAiResult(db, submissionId, result, decision, now().toISOString())
      if (decision === 'auto_accepted') {
        setInstanceStatus(db, row.instance_id, 'accepted', { completed_at: now().toISOString() })
        await notifyEmployee(row.employee_id, `Принято, ${result.score} из 100. ${result.verdict}`.trim())
        return
      }
      setInstanceStatus(db, row.instance_id, 'review')
    } catch (err) {
      console.error('photo review failed', submissionId, err)
      markAiFailed(db, submissionId, now().toISOString())
      setInstanceStatus(db, row.instance_id, 'review')
    }
    await notifyEmployee(row.employee_id, 'Отправил владельцу на проверку.')
    const freshReview = getReviewRow(db, submissionId)!
    const sent = await notifier.photosToOwner(paths, ownerReviewCaption(freshReview), reviewKeyboard(submissionId))
    if (!sent) await notifier.toOwner(ownerReviewCaption(freshReview), { keyboard: reviewKeyboard(submissionId) })
  }

  function pump(): void {
    while (running < concurrency && waiting.length > 0) {
      const id = waiting.shift()!
      running++
      active.add(id)
      process(id)
        .catch((err) => console.error('review job crashed', id, err))
        .finally(() => {
          active.delete(id)
          running--
          if (running === 0 && waiting.length === 0) {
            const w = idleWaiters
            idleWaiters = []
            w.forEach((fn) => fn())
          } else {
            pump()
          }
        })
    }
  }

  return {
    enqueue(submissionId) {
      if (waiting.includes(submissionId) || active.has(submissionId)) return
      waiting.push(submissionId)
      pump()
    },
    size: () => waiting.length + running,
    idle: () =>
      running === 0 && waiting.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve)),
  }
}
