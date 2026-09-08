import { getEmployee } from '../db/employees.js'
import { getInstanceRow, listOverdueCandidates, setInstanceStatus } from '../db/taskInstances.js'
import type { SchedulerDeps } from './tick.js'

export async function markOverdue(deps: SchedulerDeps, now: Date): Promise<number> {
  let count = 0
  for (const inst of listOverdueCandidates(deps.db, now.toISOString())) {
    try {
      setInstanceStatus(deps.db, inst.id, 'overdue')
      count++
      const row = getInstanceRow(deps.db, inst.id)
      if (!row) continue
      if (inst.status === 'open') {
        await deps.notifier.toOwner(`Никто не взял задание «${row.title}», срок истёк.`)
        continue
      }
      const employee = inst.employee_id ? getEmployee(deps.db, inst.employee_id) : null
      if (employee?.telegram_id) {
        await deps.notifier.toEmployee(employee.telegram_id, `Просрочено: «${row.title}». Выполните и сообщите владельцу.`)
      }
      await deps.notifier.toOwner(`Просрочено: «${row.title}», ${row.employee_name ?? 'без исполнителя'}.`)
    } catch (err) {
      console.error('scheduler: markOverdue failed for task', inst.id, err)
    }
  }
  return count
}
