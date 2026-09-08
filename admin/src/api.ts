export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; issues?: ({ message: string } | string)[] } | null,
  ) {
    super(`HTTP ${status}`)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    window.location.href = '/login'
    throw new ApiError(401, null)
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export type Position = { id: number; name: string }
export type Employee = {
  id: number
  full_name: string
  phone: string
  position_id: number
  telegram_id: number | null
  status: 'invited' | 'active' | 'archived'
  created_at: string
}
export type EmployeeInput = { full_name: string; phone: string; position_id: number }

export type Schedule =
  | { kind: 'weekly'; days: number[]; times: string[] }
  | { kind: 'interval'; days: number[]; from: string; to: string; every_minutes: number }

export type TaskTemplate = {
  id: number
  title: string
  description: string
  requires_photo: boolean
  photo_criteria: string | null
  auto_accept_threshold: number
  assignee_mode: 'by_position' | 'by_employees'
  distribution: 'each' | 'shared'
  schedule: Schedule | null
  deadline_minutes: number
  next_run_at: string | null
  active: boolean
  created_at: string
  position_ids: number[]
  employee_ids: number[]
  has_instances: boolean
}
export type TaskTemplateInput = Omit<TaskTemplate, 'id' | 'next_run_at' | 'active' | 'created_at' | 'has_instances'>

export type InstanceStatus = 'open' | 'pending' | 'submitted' | 'review' | 'accepted' | 'overdue'
export type InstanceRow = {
  id: number
  template_id: number
  employee_id: number | null
  slot_at: string
  issued_at: string
  due_at: string
  claimed_at: string | null
  status: InstanceStatus
  completed_at: string | null
  title: string
  requires_photo: boolean
  employee_name: string | null
  last_score: number | null
}
export type Photo = { id: number; position: number; path: string; deleted_at: string | null }
export type Submission = {
  id: number
  created_at: string
  ai_status: 'pending' | 'done' | 'failed'
  ai_score: number | null
  ai_verdict: string | null
  ai_issues: string[]
  decision: 'auto_accepted' | 'needs_review' | 'owner_accepted' | 'owner_rejected' | null
  owner_comment: string | null
  decided_at: string | null
  photos: Photo[]
}
export type ReviewRow = Submission & { instance_id: number; title: string; photo_criteria: string | null; employee_name: string }
export type InstanceFilters = { status?: InstanceStatus; employee_id?: number; template_id?: number }

export type Media = { kind: 'image'; path: string } | { kind: 'video'; url: string }
export type Lesson = { id?: number; title: string; body: string; media: Media[] }
export type Question = { id?: number; text: string; options: string[]; correct_index: number }
export type Course = {
  id: number; title: string; description: string; due_days: number; pass_score: number
  status: 'draft' | 'published' | 'archived'; published_at: string | null; assign_existing: boolean
  created_at: string; position_ids: number[]; lesson_count: number
}
export type CourseBody = { title: string; description: string; due_days: number; pass_score: number; position_ids: number[]; lessons: Lesson[]; questions: Question[] }
export type CourseDetails = { course: Course; lessons: Lesson[]; quiz: Quiz | null; questions: Question[] }
export type Quiz = {
  id: number; title: string; course_id: number | null; pass_score: number; schedule: Schedule | null; deadline_minutes: number | null
  status: 'draft' | 'published' | 'archived'; next_run_at: string | null; created_at: string; position_ids: number[]; question_count: number
}
export type QuizBody = { title: string; pass_score: number; position_ids: number[]; schedule: Schedule | null; deadline_minutes: number; questions: Question[] }
export type CourseAssignmentRow = {
  id: number; course_id: number; employee_id: number; assigned_at: string; due_at: string; current_lesson: number
  status: 'in_progress' | 'completed' | 'overdue'; completed_at: string | null; title: string; lesson_count: number; employee_name: string
}
export type QuizAssignmentRow = {
  id: number; quiz_id: number; employee_id: number; course_assignment_id: number | null; slot_at: string; assigned_at: string; due_at: string
  status: 'pending' | 'passed' | 'overdue'; passed_at: string | null; title: string; employee_name: string; open_attempt_id: number | null; course_id: number | null
}
export type QuizAttempt = { id: number; started_at: string; finished_at: string | null; current_question: number; answers: number[]; score: number | null; passed: boolean | null }

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return entries.length ? '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : ''
}

export const api = {
  me: () => request<{ ok: true }>('GET', '/api/auth/me'),
  requestCode: () => request<void>('POST', '/api/auth/request-code'),
  verify: (code: string) => request<void>('POST', '/api/auth/verify', { code }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  positions: {
    list: () => request<Position[]>('GET', '/api/positions'),
    create: (name: string) => request<Position>('POST', '/api/positions', { name }),
    rename: (id: number, name: string) => request<Position>('PATCH', `/api/positions/${id}`, { name }),
    remove: (id: number) => request<void>('DELETE', `/api/positions/${id}`),
  },
  employees: {
    list: (includeArchived: boolean) =>
      request<Employee[]>('GET', `/api/employees${includeArchived ? '?includeArchived=1' : ''}`),
    create: (input: EmployeeInput) => request<Employee>('POST', '/api/employees', input),
    update: (id: number, patch: Partial<EmployeeInput>) =>
      request<Employee>('PATCH', `/api/employees/${id}`, patch),
    archive: (id: number) => request<Employee>('POST', `/api/employees/${id}/archive`),
    unarchive: (id: number) => request<Employee>('POST', `/api/employees/${id}/unarchive`),
  },
  tasks: {
    templates: {
      list: (includeInactive = true) => request<TaskTemplate[]>('GET', `/api/tasks/templates${includeInactive ? '?includeInactive=1' : ''}`),
      get: (id: number) => request<TaskTemplate>('GET', `/api/tasks/templates/${id}`),
      create: (input: TaskTemplateInput) =>
        request<{ template: TaskTemplate; issued: { created: number; notified: number } | null }>('POST', '/api/tasks/templates', input),
      update: (id: number, input: TaskTemplateInput) => request<TaskTemplate>('PATCH', `/api/tasks/templates/${id}`, input),
      activate: (id: number) => request<TaskTemplate>('POST', `/api/tasks/templates/${id}/activate`),
      deactivate: (id: number) => request<TaskTemplate>('POST', `/api/tasks/templates/${id}/deactivate`),
      remove: (id: number) => request<void>('DELETE', `/api/tasks/templates/${id}`),
    },
    instances: {
      list: (f: InstanceFilters) => request<InstanceRow[]>('GET', `/api/tasks/instances${qs(f)}`),
      get: (id: number) => request<{ instance: InstanceRow; submissions: Submission[] }>('GET', `/api/tasks/instances/${id}`),
    },
    reviewQueue: () => request<ReviewRow[]>('GET', '/api/tasks/review-queue'),
    decide: (id: number, decision: 'accept' | 'reject', comment?: string) =>
      request<{ ok: true }>('POST', `/api/tasks/submissions/${id}/decide`, { decision, comment }),
  },
  learning: {
    courses: {
      list: (includeArchived = true) => request<Course[]>('GET', `/api/learning/courses${includeArchived ? '?includeArchived=1' : ''}`),
      get: (id: number) => request<CourseDetails>('GET', `/api/learning/courses/${id}`),
      create: (body: CourseBody) => request<CourseDetails>('POST', '/api/learning/courses', body),
      update: (id: number, body: CourseBody) => request<CourseDetails>('PATCH', `/api/learning/courses/${id}`, body),
      publish: (id: number, assignExisting: boolean) => request<{ course: Course; assigned: number }>('POST', `/api/learning/courses/${id}/publish`, { assign_existing: assignExisting }),
      archive: (id: number) => request<Course>('POST', `/api/learning/courses/${id}/archive`),
    },
    quizzes: {
      list: (includeArchived = true) => request<Quiz[]>('GET', `/api/learning/quizzes${includeArchived ? '?includeArchived=1' : ''}`),
      get: (id: number) => request<{ quiz: Quiz; questions: Question[] }>('GET', `/api/learning/quizzes/${id}`),
      create: (body: QuizBody) => request<{ quiz: Quiz; questions: Question[] }>('POST', '/api/learning/quizzes', body),
      update: (id: number, body: QuizBody) => request<{ quiz: Quiz; questions: Question[] }>('PATCH', `/api/learning/quizzes/${id}`, body),
      publish: (id: number) => request<Quiz>('POST', `/api/learning/quizzes/${id}/publish`),
      issue: (id: number) => request<{ assigned: number }>('POST', `/api/learning/quizzes/${id}/issue`),
      archive: (id: number) => request<Quiz>('POST', `/api/learning/quizzes/${id}/archive`),
    },
    assignments: {
      courses: (f: { course_id?: number; employee_id?: number; status?: string }) => request<CourseAssignmentRow[]>('GET', `/api/learning/assignments/courses${qs(f)}`),
      quizzes: (f: { quiz_id?: number; employee_id?: number; status?: string }) => request<QuizAssignmentRow[]>('GET', `/api/learning/assignments/quizzes${qs(f)}`),
      attempts: (id: number) => request<QuizAttempt[]>('GET', `/api/learning/assignments/quizzes/${id}/attempts`),
    },
    upload: async (file: File) => {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
        r.onerror = () => reject(r.error)
        r.readAsDataURL(file)
      })
      return request<{ path: string }>('POST', '/api/learning/upload', { filename: file.name, mime: file.type, data })
    },
  },
}

export function errorText(err: unknown, map: Record<string, string> = {}): string {
  if (err instanceof ApiError) {
    if (err.body?.issues?.length) return map.validation ?? err.body.issues.map((i) => (typeof i === 'string' ? i : i.message)).join('. ')
    const key = err.body?.error ?? String(err.status)
    return map[key] ?? map[String(err.status)] ?? `Ошибка ${err.status}`
  }
  return 'Нет связи с сервером'
}
