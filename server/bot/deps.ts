import type { Db } from '../db/connect.js'
import type { Notifier } from '../notify.js'

export type BotDeps = {
  db: Db
  ownerPhone: string
  publicUrl?: string
  notifier: Notifier
  tz: string
  uploadsDir: string
  downloadFile: (filePath: string) => Promise<Buffer>
  onSubmission: (submissionId: number) => void
  now: () => Date
}
