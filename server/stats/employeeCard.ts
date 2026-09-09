import type { Db } from '../db/connect.js'
import { getEmployee, type Employee } from '../db/employees.js'
import {
  listAttempts, listCourseAssignments, listQuizAssignments, type CourseAssignmentRow, type QuizAssignmentRow, type QuizAttempt,
} from '../db/learningAssignments.js'
import { employeeMetrics, type EmployeeMetrics, type Period } from './metrics.js'

export type TaskHistoryRow = { id: number; title: string; due_at: string; status: string; completed_at: string | null; last_score: number | null }
export type EmployeeCard = {
  employee: Employee
  position_name: string
  metrics: EmployeeMetrics
  tasks: TaskHistoryRow[]
  courses: CourseAssignmentRow[]
  quizzes: (QuizAssignmentRow & { attempts: QuizAttempt[] })[]
}

export function employeeCard(db: Db, employeeId: number, period: Period): EmployeeCard | null {
  const employee = getEmployee(db, employeeId)
  if (!employee) return null
  const position_name = (db.prepare('select name from positions where id = ?').get(employee.position_id) as { name: string } | undefined)?.name ?? '—'
  const tasks = db
    .prepare(
      `select i.id, t.title, i.due_at, i.status, i.completed_at,
         (select s.ai_score from task_submissions s where s.instance_id = i.id order by s.id desc limit 1) as last_score
       from task_instances i join task_templates t on t.id = i.template_id
       where i.employee_id = ? and i.due_at >= ? and i.due_at < ? order by i.due_at desc`,
    )
    .all(employeeId, period.from, period.to) as TaskHistoryRow[]
  const courses = listCourseAssignments(db, { employee_id: employeeId })
  const quizzes = listQuizAssignments(db, { employee_id: employeeId }).map((q) => ({ ...q, attempts: listAttempts(db, q.id) }))
  return { employee, position_name, metrics: employeeMetrics(db, employeeId, period), tasks, courses, quizzes }
}
