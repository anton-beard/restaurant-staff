export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; issues?: { message: string }[] } | null,
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
}

export function errorText(err: unknown, map: Record<string, string> = {}): string {
  if (err instanceof ApiError) {
    if (err.body?.issues?.length) return map.validation ?? err.body.issues.map((i) => i.message).join('. ')
    const key = err.body?.error ?? String(err.status)
    return map[key] ?? map[String(err.status)] ?? `Ошибка ${err.status}`
  }
  return 'Нет связи с сервером'
}
