export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string } | null,
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
  },
}

export function errorText(err: unknown, map: Record<string, string> = {}): string {
  if (err instanceof ApiError) {
    const key = err.body?.error ?? String(err.status)
    return map[key] ?? map[String(err.status)] ?? `Ошибка ${err.status}`
  }
  return 'Нет связи с сервером'
}
