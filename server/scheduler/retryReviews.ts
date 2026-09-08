import { join } from 'node:path'
import { setInstanceStatus } from '../db/taskInstances.js'
import { getReviewRow, listPhotos, listStaleAiPending, markAiFailed } from '../db/taskSubmissions.js'
import { ownerReviewCaption } from '../tasks/decide.js'
import { reviewKeyboard } from '../bot/keyboards.js'
import type { SchedulerDeps } from './tick.js'

export const STALE_REVIEW_MS = 3 * 60_000
export const MAX_AI_ATTEMPTS = 3

export async function retryStaleReviews(deps: SchedulerDeps, now: Date): Promise<{ retried: number; failed: number }> {
  let retried = 0
  let failed = 0
  const before = new Date(now.getTime() - STALE_REVIEW_MS).toISOString()
  for (const s of listStaleAiPending(deps.db, before)) {
    // запрос к модели ещё в очереди или в полёте: он сам допишет результат, вмешиваться нельзя
    if (deps.reviewQueue.isActive(s.id)) continue
    if (s.ai_attempts < MAX_AI_ATTEMPTS) {
      if (deps.reviewQueue.enqueue(s.id)) retried++
      continue
    }
    markAiFailed(deps.db, s.id, now.toISOString())
    setInstanceStatus(deps.db, s.instance_id, 'review')
    failed++
    const row = getReviewRow(deps.db, s.id)
    if (!row) continue
    const paths = listPhotos(deps.db, s.id).filter((p) => !p.deleted_at).map((p) => join(deps.uploadsDir, p.path))
    const caption = ownerReviewCaption(row)
    const sent = await deps.notifier.photosToOwner(paths, caption, reviewKeyboard(s.id))
    if (!sent) await deps.notifier.toOwner(caption, { keyboard: reviewKeyboard(s.id) })
  }
  return { retried, failed }
}
