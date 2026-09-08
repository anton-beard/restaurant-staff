import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { purgeAuth } from '../db/maintenance.js'
import { getSetting } from '../db/settings.js'
import { listPhotosOlderThan, markPhotoDeleted } from '../db/taskSubmissions.js'
import type { SchedulerDeps } from './tick.js'

export const DEFAULT_RETENTION_DAYS = 90
export const PHOTO_RETENTION_KEY = 'photo_retention_days'

export async function cleanup(deps: SchedulerDeps, now: Date): Promise<{ photos: number; sessions: number; codes: number }> {
  const days = Number(getSetting(deps.db, PHOTO_RETENTION_KEY) ?? DEFAULT_RETENTION_DAYS)
  const before = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString()
  let photos = 0
  for (const p of listPhotosOlderThan(deps.db, before)) {
    rmSync(join(deps.uploadsDir, p.path), { force: true })
    markPhotoDeleted(deps.db, p.id, now.toISOString())
    photos++
  }
  const auth = purgeAuth(deps.db, now.getTime())
  return { photos, ...auth }
}
