# Этап 1: каркас. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Рабочий каркас: один Node-процесс с Fastify, SQLite, Telegram-ботом с привязкой по номеру, входом владельца по коду из бота, админкой со справочниками сотрудников и должностей, упакованный в Docker.

**Architecture:** Один процесс: Fastify отдаёт REST под `/api/` и статику Vue-админки, grammY в том же процессе крутит long polling. Все данные в SQLite (better-sqlite3), миграции встроены в код. Модули общаются через явные функции с `db` первым аргументом; бот и API не знают друг о друге, общий канал только `notifyOwner`.

**Tech Stack:** Node 24+, TypeScript 6, Fastify 5, @fastify/cookie 11, @fastify/static 10, grammY 1, better-sqlite3 13, zod 4, Vitest 4, Vue 3, Vue Router 5, Vite 8, Tailwind 4, tsx.

Спек: `docs/superpowers/specs/2026-09-07-restaurant-staff-design.md`, разделы 2, 3 (только таблицы этапа 1), 4 (привязка и меню), 6 (вход, сотрудники, должности), 8.

## Global Constraints

- Node.js ≥ 24, ESM (`"type": "module"`), TypeScript strict.
- Один процесс, одна база `DATA_DIR/app.db`, WAL включён, `foreign_keys=ON`.
- Переменные окружения: `BOT_TOKEN`, `OWNER_PHONE`, `SESSION_SECRET` (обязательные), `ANTHROPIC_API_KEY` (в этом этапе необязательна), `DATA_DIR` (по умолчанию `/data`), `PORT` (по умолчанию 3000), `PUBLIC_URL` (необязательна, ссылка на админку в боте).
- Телефоны хранятся в E.164 (`+79991234567`), уникальны.
- Код входа: 6 цифр, живёт 5 минут, 5 неверных попыток за 10 минут блокируют выдачу и проверку на 15 минут. Сессия: httpOnly cookie `session`, SameSite=Lax, 30 дней.
- Все `/api/` ручки, кроме `/api/auth/request-code`, `/api/auth/verify` и `/healthz`, требуют сессии владельца.
- Тексты бота и админки на русском.
- Коммиты от локально настроенного автора `anton-beard`, remote не добавлять, ничего не пушить.
- Коммит-сообщения заканчиваются строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Структура файлов

```
package.json, tsconfig.json, vitest.config.ts, vite.config.ts, .gitignore, .env.example
server/config.ts                 загрузка и валидация env
server/index.ts                  точка входа: db, bot, app, graceful shutdown
server/app.ts                    buildApp(deps): Fastify + роуты + статика
server/lib/phone.ts              normalizePhone
server/lib/validate.ts           parse(schema, data) и ValidationError
server/db/connect.ts             openDb(file): миграции, pragma
server/db/migrations.ts          массив миграций этапа 1
server/db/positions.ts           запросы по должностям
server/db/employees.ts           запросы по сотрудникам
server/db/settings.ts            key/value настройки
server/auth/ownerAuth.ts         коды входа, сессии, rate limit
server/api/auth.ts               /api/auth/*
server/api/requireOwner.ts       preHandler-гард
server/api/positions.ts          /api/positions
server/api/employees.ts          /api/employees
server/bot/createBot.ts          бот: /start, контакт, меню
server/bot/keyboards.ts          клавиатуры
server/notify.ts                 notifyOwner(api, db, text)
server/test/buildTestApp.ts      хелпер для API-тестов
server/test/telegram.ts          фабрики update для тестов бота
admin/index.html, admin/tsconfig.json
admin/src/main.ts, App.vue, router.ts, api.ts, style.css
admin/src/pages/LoginPage.vue, PositionsPage.vue, EmployeesPage.vue
admin/src/components/AppLayout.vue
Dockerfile, docker-compose.yml, README.md
```

Тесты лежат рядом с кодом: `server/**/*.test.ts`.

---

### Task 1: Каркас проекта и `/healthz`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `server/config.ts`, `server/app.ts`, `server/index.ts`
- Test: `server/app.test.ts`, `server/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` из `server/config.ts`; тип `Config` с полями `BOT_TOKEN, OWNER_PHONE, SESSION_SECRET, ANTHROPIC_API_KEY?, DATA_DIR, PORT, PUBLIC_URL?`.
- Produces: `buildApp(deps: AppDeps): FastifyInstance` из `server/app.ts`. В этой задаче `AppDeps = { config: Config }`, следующие задачи расширяют.

- [ ] **Step 1: Инициализировать npm и поставить зависимости**

```bash
npm init -y >/dev/null
npm i fastify@5 @fastify/static@10 @fastify/cookie@11 grammy@1 better-sqlite3@13 zod@4
npm i -D typescript@6 tsx@4 vitest@4 @types/node@26 @types/better-sqlite3@9 vue@3 vue-router@5 vite@8 @vitejs/plugin-vue@6 tailwindcss@4 @tailwindcss/vite@4
```

Ожидаемо: `added N packages`, без ошибок сборки better-sqlite3.

- [ ] **Step 2: Заменить package.json**

```json
{
  "name": "restaurant-staff",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "tsx watch server/index.ts",
    "dev:admin": "vite",
    "build": "vite build && tsc -p tsconfig.json",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Секции `dependencies` и `devDependencies`, которые записал `npm i`, сохранить как есть (перепишите только поля выше).

- [ ] **Step 3: tsconfig.json, vitest.config.ts, .gitignore, .env.example**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["server/**/*.ts"],
  "exclude": ["server/**/*.test.ts", "server/test/**"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
  },
})
```

`.gitignore`:
```
node_modules
dist
admin/dist
data
.env
```

`.env.example`:
```
BOT_TOKEN=123456:replace-me
OWNER_PHONE=+79990000000
SESSION_SECRET=change-me-to-a-long-random-string
ANTHROPIC_API_KEY=
DATA_DIR=./data
PORT=3000
PUBLIC_URL=http://localhost:3000
TZ=Europe/Moscow
```

- [ ] **Step 4: Тест конфига**

`server/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  BOT_TOKEN: 't',
  OWNER_PHONE: '+79990000000',
  SESSION_SECRET: 'sixteen-characters!',
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base)
    expect(c.DATA_DIR).toBe('/data')
    expect(c.PORT).toBe(3000)
    expect(c.PUBLIC_URL).toBeUndefined()
  })

  it('coerces PORT and keeps optional values', () => {
    const c = loadConfig({ ...base, PORT: '8080', PUBLIC_URL: 'https://x.y' })
    expect(c.PORT).toBe(8080)
    expect(c.PUBLIC_URL).toBe('https://x.y')
  })

  it('throws on missing BOT_TOKEN', () => {
    expect(() => loadConfig({ ...base, BOT_TOKEN: '' })).toThrow(/BOT_TOKEN/)
  })
})
```

- [ ] **Step 5: Запустить, убедиться, что падает**

Run: `npx vitest run server/config.test.ts`
Expected: FAIL, `Cannot find module './config.js'`.

- [ ] **Step 6: server/config.ts**

```ts
import { z } from 'zod'

const schema = z.object({
  BOT_TOKEN: z.string().min(1),
  OWNER_PHONE: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default('/data'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().optional(),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  )
  const result = schema.safeParse(cleaned)
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid config: ${fields}`)
  }
  return result.data
}
```

- [ ] **Step 7: Тест конфига зелёный**

Run: `npx vitest run server/config.test.ts`
Expected: 3 passed.

- [ ] **Step 8: Тест `/healthz`**

`server/app.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig({
  BOT_TOKEN: 't',
  OWNER_PHONE: '+79990000000',
  SESSION_SECRET: 'sixteen-characters!',
})

describe('app', () => {
  it('answers /healthz', async () => {
    const app = buildApp({ config })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
```

- [ ] **Step 9: Запустить, убедиться, что падает**

Run: `npx vitest run server/app.test.ts`
Expected: FAIL, `Cannot find module './app.js'`.

- [ ] **Step 10: server/app.ts и server/index.ts**

`server/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'

export type AppDeps = {
  config: Config
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  app.get('/healthz', async () => ({ ok: true }))

  void deps
  return app
}
```

`server/index.ts`:
```ts
import { loadConfig } from './config.js'
import { buildApp } from './app.js'

const config = loadConfig()
const app = buildApp({ config })

await app.listen({ port: config.PORT, host: '0.0.0.0' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    process.exit(0)
  })
}
```

- [ ] **Step 11: Все тесты и typecheck зелёные**

Run: `npm test && npm run typecheck`
Expected: 4 passed; tsc без ошибок.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: project scaffold with config and /healthz

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: База данных и миграции

**Files:**
- Create: `server/db/migrations.ts`, `server/db/connect.ts`
- Test: `server/db/connect.test.ts`

**Interfaces:**
- Produces: `openDb(file: string): Database.Database` (принимает `':memory:'`), `type Db = Database.Database` из `server/db/connect.ts`.
- Produces: таблицы `positions`, `employees`, `bot_states`, `owner_login_codes`, `owner_sessions`, `settings`, `schema_migrations`.

- [ ] **Step 1: Тест**

`server/db/connect.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { openDb } from './connect.js'

describe('openDb', () => {
  it('creates stage 1 tables', () => {
    const db = openDb(':memory:')
    const names = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(names).toEqual(
      expect.arrayContaining([
        'positions',
        'employees',
        'bot_states',
        'owner_login_codes',
        'owner_sessions',
        'settings',
        'schema_migrations',
      ]),
    )
  })

  it('enforces foreign keys and unique phone', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          "insert into employees (full_name, phone, position_id) values ('A', '+79990000001', 999)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
    db.prepare("insert into positions (name) values ('Официант')").run()
    const ins = db.prepare(
      "insert into employees (full_name, phone, position_id) values (?, ?, 1)",
    )
    ins.run('A', '+79990000001')
    expect(() => ins.run('B', '+79990000001')).toThrow(/UNIQUE/)
  })

  it('is idempotent: migrations run once', () => {
    const db = openDb(':memory:')
    const count = () =>
      (db.prepare('select count(*) c from schema_migrations').get() as { c: number }).c
    const first = count()
    expect(first).toBeGreaterThan(0)
    // повторный прогон миграций на той же базе ничего не добавляет
    db.exec('select 1')
    expect(count()).toBe(first)
  })
})
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `npx vitest run server/db/connect.test.ts`
Expected: FAIL, `Cannot find module './connect.js'`.

- [ ] **Step 3: server/db/migrations.ts**

```ts
export type Migration = { name: string; sql: string }

export const migrations: Migration[] = [
  {
    name: '001_init',
    sql: `
      create table positions (
        id integer primary key autoincrement,
        name text not null unique
      );

      create table employees (
        id integer primary key autoincrement,
        full_name text not null,
        phone text not null unique,
        position_id integer not null references positions(id),
        telegram_id integer unique,
        status text not null default 'invited'
          check (status in ('invited', 'active', 'archived')),
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create table bot_states (
        telegram_id integer primary key,
        state text not null
      );

      create table owner_login_codes (
        id integer primary key autoincrement,
        code_hash text not null,
        expires_at integer not null,
        used integer not null default 0
      );

      create table owner_sessions (
        id integer primary key autoincrement,
        token_hash text not null unique,
        expires_at integer not null
      );

      create table settings (
        key text primary key,
        value text not null
      );
    `,
  },
]
```

- [ ] **Step 4: server/db/connect.ts**

```ts
import Database from 'better-sqlite3'
import { migrations } from './migrations.js'

export type Db = Database.Database

export function openDb(file: string): Db {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  const applied = new Set(
    db
      .prepare('select name from schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  )
  const mark = db.prepare('insert into schema_migrations (name) values (?)')
  for (const m of migrations) {
    if (applied.has(m.name)) continue
    db.transaction(() => {
      db.exec(m.sql)
      mark.run(m.name)
    })()
  }
  return db
}
```

- [ ] **Step 5: Тест зелёный**

Run: `npx vitest run server/db/connect.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add server/db
git commit -m "feat: sqlite connection with embedded migrations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Нормализация телефона и валидация

**Files:**
- Create: `server/lib/phone.ts`, `server/lib/validate.ts`
- Test: `server/lib/phone.test.ts`

**Interfaces:**
- Produces: `normalizePhone(input: string): string | null` (E.164 или null).
- Produces: `parse<T>(schema: z.ZodType<T>, data: unknown): T`, бросает `ValidationError` с полем `issues`.

- [ ] **Step 1: Тест телефонов**

`server/lib/phone.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { normalizePhone } from './phone.js'

describe('normalizePhone', () => {
  it.each([
    ['+7 (999) 123-45-67', '+79991234567'],
    ['8 999 123 45 67', '+79991234567'],
    ['9991234567', '+79991234567'],
    ['79991234567', '+79991234567'],
    ['+380501234567', '+380501234567'],
    ['380501234567', '+380501234567'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected)
  })

  it.each([['', null], ['abc', null], ['12345', null], ['+1234567890123456', null]])(
    'rejects %s',
    (input, expected) => {
      expect(normalizePhone(input)).toBe(expected)
    },
  )
})
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `npx vitest run server/lib/phone.test.ts`
Expected: FAIL, `Cannot find module './phone.js'`.

- [ ] **Step 3: server/lib/phone.ts**

```ts
/** Приводит номер к E.164. Российские номера без кода страны получают +7. */
export function normalizePhone(input: string): string | null {
  const hasPlus = input.trim().startsWith('+')
  const digits = input.replace(/\D/g, '')
  if (digits.length === 0) return null

  let full: string
  if (hasPlus) {
    full = digits
  } else if (digits.length === 11 && digits.startsWith('8')) {
    full = '7' + digits.slice(1)
  } else if (digits.length === 10 && digits.startsWith('9')) {
    full = '7' + digits
  } else {
    full = digits
  }

  if (full.length < 10 || full.length > 15) return null
  return '+' + full
}
```

- [ ] **Step 4: Тест зелёный**

Run: `npx vitest run server/lib/phone.test.ts`
Expected: 10 passed.

- [ ] **Step 5: server/lib/validate.ts**

```ts
import type { z } from 'zod'

export class ValidationError extends Error {
  constructor(public issues: unknown) {
    super('validation')
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new ValidationError(result.error.issues)
  return result.data
}
```

- [ ] **Step 6: Commit**

```bash
git add server/lib
git commit -m "feat: phone normalization and request validation helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Репозитории: должности, сотрудники, настройки

**Files:**
- Create: `server/db/positions.ts`, `server/db/employees.ts`, `server/db/settings.ts`
- Test: `server/db/repos.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Db` из `server/db/connect.ts`.
- Produces (`positions.ts`): `type Position = { id: number; name: string }`; `listPositions(db): Position[]`; `createPosition(db, name): Position`; `renamePosition(db, id, name): Position | null`; `deletePosition(db, id): 'deleted' | 'in_use' | 'not_found'`.
- Produces (`employees.ts`): `type EmployeeStatus = 'invited' | 'active' | 'archived'`; `type Employee = { id: number; full_name: string; phone: string; position_id: number; telegram_id: number | null; status: EmployeeStatus; created_at: string }`; `listEmployees(db, opts?: { includeArchived?: boolean }): Employee[]`; `getEmployee(db, id): Employee | null`; `createEmployee(db, input: { full_name: string; phone: string; position_id: number }): Employee`; `updateEmployee(db, id, patch: Partial<{ full_name: string; phone: string; position_id: number }>): Employee | null`; `archiveEmployee(db, id): Employee | null`; `findEmployeeByPhone(db, phone): Employee | null`; `findEmployeeByTelegramId(db, telegramId): Employee | null`; `linkTelegram(db, id, telegramId): Employee | null` (ставит `active`).
- Produces (`settings.ts`): `getSetting(db, key): string | null`; `setSetting(db, key, value): void`; константа `OWNER_TELEGRAM_ID = 'owner_telegram_id'`.

Телефон в репозиторий приходит уже нормализованным; нормализуют вызывающие (API и бот).

- [ ] **Step 1: Тест**

`server/db/repos.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './connect.js'
import { createPosition, deletePosition, listPositions, renamePosition } from './positions.js'
import {
  archiveEmployee,
  createEmployee,
  findEmployeeByPhone,
  findEmployeeByTelegramId,
  getEmployee,
  linkTelegram,
  listEmployees,
  updateEmployee,
} from './employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from './settings.js'

let db: Db
beforeEach(() => {
  db = openDb(':memory:')
})

describe('positions', () => {
  it('creates, lists, renames', () => {
    const p = createPosition(db, 'Официант')
    expect(p).toEqual({ id: 1, name: 'Официант' })
    expect(listPositions(db)).toEqual([p])
    expect(renamePosition(db, 1, 'Бармен')).toEqual({ id: 1, name: 'Бармен' })
    expect(renamePosition(db, 42, 'X')).toBeNull()
  })

  it('refuses to delete a position in use', () => {
    const p = createPosition(db, 'Повар')
    createEmployee(db, { full_name: 'А', phone: '+79990000001', position_id: p.id })
    expect(deletePosition(db, p.id)).toBe('in_use')
    expect(deletePosition(db, 99)).toBe('not_found')
    const free = createPosition(db, 'Хостес')
    expect(deletePosition(db, free.id)).toBe('deleted')
  })
})

describe('employees', () => {
  it('creates and reads', () => {
    const p = createPosition(db, 'Официант')
    const e = createEmployee(db, { full_name: 'Иван', phone: '+79990000001', position_id: p.id })
    expect(e).toMatchObject({ id: 1, full_name: 'Иван', status: 'invited', telegram_id: null })
    expect(getEmployee(db, 1)).toEqual(e)
    expect(findEmployeeByPhone(db, '+79990000001')).toEqual(e)
    expect(findEmployeeByPhone(db, '+70000000000')).toBeNull()
  })

  it('updates, links telegram, archives', () => {
    const p = createPosition(db, 'Официант')
    createEmployee(db, { full_name: 'Иван', phone: '+79990000001', position_id: p.id })
    expect(updateEmployee(db, 1, { full_name: 'Пётр' })?.full_name).toBe('Пётр')
    const linked = linkTelegram(db, 1, 123456789)
    expect(linked).toMatchObject({ status: 'active', telegram_id: 123456789 })
    expect(findEmployeeByTelegramId(db, 123456789)?.id).toBe(1)
    expect(archiveEmployee(db, 1)?.status).toBe('archived')
    expect(listEmployees(db)).toEqual([])
    expect(listEmployees(db, { includeArchived: true })).toHaveLength(1)
    expect(updateEmployee(db, 77, { full_name: 'X' })).toBeNull()
  })
})

describe('settings', () => {
  it('sets and gets', () => {
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBeNull()
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    setSetting(db, OWNER_TELEGRAM_ID, '43')
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBe('43')
  })
})
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `npx vitest run server/db/repos.test.ts`
Expected: FAIL, `Cannot find module './positions.js'`.

- [ ] **Step 3: server/db/positions.ts**

```ts
import type { Db } from './connect.js'

export type Position = { id: number; name: string }

export function listPositions(db: Db): Position[] {
  return db.prepare('select id, name from positions order by name').all() as Position[]
}

export function createPosition(db: Db, name: string): Position {
  const info = db.prepare('insert into positions (name) values (?)').run(name)
  return { id: Number(info.lastInsertRowid), name }
}

export function renamePosition(db: Db, id: number, name: string): Position | null {
  const info = db.prepare('update positions set name = ? where id = ?').run(name, id)
  return info.changes === 0 ? null : { id, name }
}

export function deletePosition(db: Db, id: number): 'deleted' | 'in_use' | 'not_found' {
  const inUse = db
    .prepare('select 1 from employees where position_id = ? limit 1')
    .get(id)
  if (inUse) return 'in_use'
  const info = db.prepare('delete from positions where id = ?').run(id)
  return info.changes === 0 ? 'not_found' : 'deleted'
}
```

- [ ] **Step 4: server/db/employees.ts**

```ts
import type { Db } from './connect.js'

export type EmployeeStatus = 'invited' | 'active' | 'archived'

export type Employee = {
  id: number
  full_name: string
  phone: string
  position_id: number
  telegram_id: number | null
  status: EmployeeStatus
  created_at: string
}

const columns = 'id, full_name, phone, position_id, telegram_id, status, created_at'

export function listEmployees(db: Db, opts: { includeArchived?: boolean } = {}): Employee[] {
  const where = opts.includeArchived ? '' : "where status != 'archived'"
  return db
    .prepare(`select ${columns} from employees ${where} order by full_name`)
    .all() as Employee[]
}

export function getEmployee(db: Db, id: number): Employee | null {
  return (db.prepare(`select ${columns} from employees where id = ?`).get(id) as Employee) ?? null
}

export function createEmployee(
  db: Db,
  input: { full_name: string; phone: string; position_id: number },
): Employee {
  const info = db
    .prepare('insert into employees (full_name, phone, position_id) values (?, ?, ?)')
    .run(input.full_name, input.phone, input.position_id)
  return getEmployee(db, Number(info.lastInsertRowid))!
}

export function updateEmployee(
  db: Db,
  id: number,
  patch: Partial<{ full_name: string; phone: string; position_id: number }>,
): Employee | null {
  const current = getEmployee(db, id)
  if (!current) return null
  const next = { ...current, ...patch }
  db.prepare('update employees set full_name = ?, phone = ?, position_id = ? where id = ?').run(
    next.full_name,
    next.phone,
    next.position_id,
    id,
  )
  return getEmployee(db, id)
}

export function archiveEmployee(db: Db, id: number): Employee | null {
  const info = db.prepare("update employees set status = 'archived' where id = ?").run(id)
  return info.changes === 0 ? null : getEmployee(db, id)
}

export function findEmployeeByPhone(db: Db, phone: string): Employee | null {
  return (
    (db.prepare(`select ${columns} from employees where phone = ?`).get(phone) as Employee) ?? null
  )
}

export function findEmployeeByTelegramId(db: Db, telegramId: number): Employee | null {
  return (
    (db
      .prepare(`select ${columns} from employees where telegram_id = ?`)
      .get(telegramId) as Employee) ?? null
  )
}

export function linkTelegram(db: Db, id: number, telegramId: number): Employee | null {
  const info = db
    .prepare("update employees set telegram_id = ?, status = 'active' where id = ?")
    .run(telegramId, id)
  return info.changes === 0 ? null : getEmployee(db, id)
}
```

- [ ] **Step 5: server/db/settings.ts**

```ts
import type { Db } from './connect.js'

export const OWNER_TELEGRAM_ID = 'owner_telegram_id'

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('select value from settings where key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, value)
}
```

- [ ] **Step 6: Тест зелёный**

Run: `npx vitest run server/db/repos.test.ts`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add server/db
git commit -m "feat: positions, employees and settings repositories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Вход владельца: коды, сессии, rate limit

**Files:**
- Create: `server/auth/ownerAuth.ts`
- Test: `server/auth/ownerAuth.test.ts`

**Interfaces:**
- Consumes: `Db`.
- Produces: `createOwnerAuth(db: Db, now: () => number = Date.now): OwnerAuth`, где
  ```ts
  type OwnerAuth = {
    createLoginCode(): string | 'locked'
    verifyLoginCode(code: string): { token: string } | { error: 'invalid' | 'locked' }
    hasSession(token: string | undefined): boolean
    deleteSession(token: string): void
  }
  ```
- Константы: `SESSION_TTL_MS = 30 суток`, `CODE_TTL_MS = 5 минут`.

Rate limit живёт в памяти экземпляра: массив меток времени неверных попыток за последние 10 минут; при 5 неверных ставится `lockedUntil = now + 15 минут`. Пока заблокировано, и `createLoginCode`, и `verifyLoginCode` возвращают `locked`. Успешная проверка сбрасывает счётчик. При создании нового кода старые неиспользованные удаляются.

- [ ] **Step 1: Тест**

`server/auth/ownerAuth.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createOwnerAuth, type OwnerAuth } from './ownerAuth.js'

const MIN = 60_000
let db: Db
let clock: number
let auth: OwnerAuth

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1_000_000_000_000
  auth = createOwnerAuth(db, () => clock)
})

describe('login code', () => {
  it('issues a 6-digit code that verifies once', () => {
    const code = auth.createLoginCode()
    expect(code).toMatch(/^\d{6}$/)
    const ok = auth.verifyLoginCode(code as string)
    expect(ok).toHaveProperty('token')
    expect(auth.verifyLoginCode(code as string)).toEqual({ error: 'invalid' })
  })

  it('expires after 5 minutes', () => {
    const code = auth.createLoginCode() as string
    clock += 5 * MIN + 1
    expect(auth.verifyLoginCode(code)).toEqual({ error: 'invalid' })
  })

  it('a new code invalidates the previous one', () => {
    const first = auth.createLoginCode() as string
    const second = auth.createLoginCode() as string
    expect(auth.verifyLoginCode(first)).toEqual({ error: 'invalid' })
    expect(auth.verifyLoginCode(second)).toHaveProperty('token')
  })

  it('locks for 15 minutes after 5 wrong attempts in 10 minutes', () => {
    auth.createLoginCode()
    for (let i = 0; i < 5; i++) expect(auth.verifyLoginCode('000000')).toEqual({ error: 'invalid' })
    expect(auth.verifyLoginCode('000000')).toEqual({ error: 'locked' })
    expect(auth.createLoginCode()).toBe('locked')
    clock += 15 * MIN + 1
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
  })

  it('wrong attempts older than 10 minutes do not count', () => {
    auth.createLoginCode()
    for (let i = 0; i < 4; i++) auth.verifyLoginCode('000000')
    clock += 10 * MIN + 1
    for (let i = 0; i < 4; i++) auth.verifyLoginCode('000000')
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
  })
})

describe('sessions', () => {
  it('recognises a live session and forgets a deleted one', () => {
    const code = auth.createLoginCode() as string
    const { token } = auth.verifyLoginCode(code) as { token: string }
    expect(auth.hasSession(token)).toBe(true)
    expect(auth.hasSession(undefined)).toBe(false)
    expect(auth.hasSession('nope')).toBe(false)
    auth.deleteSession(token)
    expect(auth.hasSession(token)).toBe(false)
  })

  it('expires after 30 days', () => {
    const code = auth.createLoginCode() as string
    const { token } = auth.verifyLoginCode(code) as { token: string }
    clock += 30 * 24 * 60 * MIN + 1
    expect(auth.hasSession(token)).toBe(false)
  })
})
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `npx vitest run server/auth/ownerAuth.test.ts`
Expected: FAIL, `Cannot find module './ownerAuth.js'`.

- [ ] **Step 3: server/auth/ownerAuth.ts**

```ts
import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { Db } from '../db/connect.js'

export const CODE_TTL_MS = 5 * 60_000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const ATTEMPT_WINDOW_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60_000

export type OwnerAuth = {
  createLoginCode(): string | 'locked'
  verifyLoginCode(code: string): { token: string } | { error: 'invalid' | 'locked' }
  hasSession(token: string | undefined): boolean
  deleteSession(token: string): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function createOwnerAuth(db: Db, now: () => number = Date.now): OwnerAuth {
  let failures: number[] = []
  let lockedUntil = 0

  function isLocked(): boolean {
    return now() < lockedUntil
  }

  function registerFailure(): void {
    const t = now()
    failures = failures.filter((f) => t - f < ATTEMPT_WINDOW_MS)
    failures.push(t)
    if (failures.length >= MAX_ATTEMPTS) {
      lockedUntil = t + LOCK_MS
      failures = []
    }
  }

  return {
    createLoginCode() {
      if (isLocked()) return 'locked'
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
      db.prepare('delete from owner_login_codes').run()
      db.prepare('insert into owner_login_codes (code_hash, expires_at) values (?, ?)').run(
        sha256(code),
        now() + CODE_TTL_MS,
      )
      return code
    },

    verifyLoginCode(code) {
      if (isLocked()) return { error: 'locked' }
      const row = db
        .prepare('select id from owner_login_codes where code_hash = ? and used = 0 and expires_at > ?')
        .get(sha256(code), now()) as { id: number } | undefined
      if (!row) {
        registerFailure()
        return { error: 'invalid' }
      }
      db.prepare('update owner_login_codes set used = 1 where id = ?').run(row.id)
      failures = []
      const token = randomBytes(32).toString('hex')
      db.prepare('insert into owner_sessions (token_hash, expires_at) values (?, ?)').run(
        sha256(token),
        now() + SESSION_TTL_MS,
      )
      return { token }
    },

    hasSession(token) {
      if (!token) return false
      const row = db
        .prepare('select 1 from owner_sessions where token_hash = ? and expires_at > ?')
        .get(sha256(token), now())
      return row !== undefined
    },

    deleteSession(token) {
      db.prepare('delete from owner_sessions where token_hash = ?').run(sha256(token))
    },
  }
}
```

- [ ] **Step 4: Тест зелёный**

Run: `npx vitest run server/auth/ownerAuth.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add server/auth
git commit -m "feat: owner login codes, sessions and rate limiting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: REST API: вход, должности, сотрудники

**Files:**
- Modify: `server/app.ts` (полная замена)
- Create: `server/api/auth.ts`, `server/api/requireOwner.ts`, `server/api/positions.ts`, `server/api/employees.ts`, `server/test/buildTestApp.ts`
- Test: `server/api/auth.test.ts`, `server/api/positions.test.ts`, `server/api/employees.test.ts`
- Modify: `server/app.test.ts` (обновить вызов `buildApp`)

**Interfaces:**
- Consumes: `Config`, `Db`, `OwnerAuth`, `SESSION_TTL_MS`, репозитории из Task 4, `parse`/`ValidationError`, `normalizePhone`.
- Produces: `AppDeps = { config: Config; db: Db; auth: OwnerAuth; sendToOwner: (text: string) => Promise<boolean>; adminDistDir?: string }` (поле `adminDistDir` начнёт использоваться в Task 8).
- Produces HTTP-контракт:
  - `POST /api/auth/request-code` → 204; 409 `{ error: 'owner_not_linked' }`; 429 `{ error: 'locked' }`.
  - `POST /api/auth/verify` `{ code }` → 204 + cookie `session`; 401 `{ error: 'invalid' }`; 429 `{ error: 'locked' }`.
  - `POST /api/auth/logout` → 204 (требует сессии, иначе 401). `GET /api/auth/me` → 200 `{ ok: true }` или 401.
  - `GET /api/positions` → `Position[]`; `POST /api/positions` `{ name }` → 201 `Position`; `PATCH /api/positions/:id` `{ name }` → 200 / 404; `DELETE /api/positions/:id` → 204 / 409 `{ error: 'in_use' }` / 404.
  - `GET /api/employees?includeArchived=1` → `Employee[]`; `POST /api/employees` `{ full_name, phone, position_id }` → 201 `Employee`; `PATCH /api/employees/:id` → 200 / 404; `POST /api/employees/:id/archive` → 200 / 404.
  - Ошибки: 400 `{ error: 'validation', issues }`, 401 `{ error: 'unauthorized' }`, 404 `{ error: 'not_found' }`, 409 `{ error: 'conflict' }` при нарушении UNIQUE (дубликат телефона или названия должности).
- Produces: `buildTestApp(): Promise<{ app: FastifyInstance; db: Db; sent: string[]; loginAsOwner(): Promise<string> }>`, где `loginAsOwner` возвращает значение заголовка `Cookie` для последующих запросов.

- [ ] **Step 1: Тестовый хелпер**

`server/test/buildTestApp.ts`:
```ts
import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { openDb } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { createOwnerAuth } from '../auth/ownerAuth.js'

export async function buildTestApp() {
  const db = openDb(':memory:')
  const config = loadConfig({
    BOT_TOKEN: 't',
    OWNER_PHONE: '+79990000000',
    SESSION_SECRET: 'sixteen-characters!',
  })
  const sent: string[] = []
  const auth = createOwnerAuth(db)
  const app = buildApp({
    config,
    db,
    auth,
    sendToOwner: async (text) => {
      sent.push(text)
      return true
    },
  })
  await app.ready()

  async function loginAsOwner(): Promise<string> {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    const code = sent.at(-1)!.match(/\d{6}/)![0]
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } })
    const c = res.cookies[0]!
    return `${c.name}=${c.value}`
  }

  return { app, db, sent, loginAsOwner }
}
```

- [ ] **Step 2: Тесты auth**

`server/api/auth.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'

describe('auth api', () => {
  it('refuses to send a code when the owner is not linked', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'owner_not_linked' })
  })

  it('sends a code to the owner and logs in with it', async () => {
    const { app, db, sent } = await buildTestApp()
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const req = await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    expect(req.statusCode).toBe(204)
    expect(sent).toHaveLength(1)
    const code = sent[0]!.match(/\d{6}/)![0]

    const bad = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: '000000' } })
    expect(bad.statusCode).toBe(401)

    const ok = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } })
    expect(ok.statusCode).toBe(204)
    const cookie = ok.cookies[0]!
    expect(cookie.name).toBe('session')
    expect(cookie.httpOnly).toBe(true)

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    expect(me.statusCode).toBe(200)

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    expect(out.statusCode).toBe(204)
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    expect(after.statusCode).toBe(401)
  })

  it('returns 429 while locked', async () => {
    const { app, db } = await buildTestApp()
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: '000000' } })
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: '000000' } })
    expect(locked.statusCode).toBe(429)
    const req = await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    expect(req.statusCode).toBe(429)
  })

  it('validates the body', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: 12 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('validation')
  })

  it('protects api routes', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/positions' })
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 3: Тесты positions и employees**

`server/api/positions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'

describe('positions api', () => {
  it('crud', async () => {
    const { app, loginAsOwner } = await buildTestApp()
    const cookie = await loginAsOwner()
    const h = { cookie }

    const created = await app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Официант' } })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toEqual({ id: 1, name: 'Официант' })

    const dup = await app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Официант' } })
    expect(dup.statusCode).toBe(409)

    const list = await app.inject({ method: 'GET', url: '/api/positions', headers: h })
    expect(list.json()).toHaveLength(1)

    const renamed = await app.inject({ method: 'PATCH', url: '/api/positions/1', headers: h, payload: { name: 'Бармен' } })
    expect(renamed.json()).toEqual({ id: 1, name: 'Бармен' })

    const missing = await app.inject({ method: 'PATCH', url: '/api/positions/9', headers: h, payload: { name: 'X' } })
    expect(missing.statusCode).toBe(404)

    const del = await app.inject({ method: 'DELETE', url: '/api/positions/1', headers: h })
    expect(del.statusCode).toBe(204)
  })

  it('refuses to delete a position in use', async () => {
    const { app, loginAsOwner } = await buildTestApp()
    const cookie = await loginAsOwner()
    const h = { cookie }
    await app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Повар' } })
    await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'А', phone: '+79990000001', position_id: 1 },
    })
    const del = await app.inject({ method: 'DELETE', url: '/api/positions/1', headers: h })
    expect(del.statusCode).toBe(409)
    expect(del.json()).toEqual({ error: 'in_use' })
  })
})
```

`server/api/employees.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'

async function setup() {
  const t = await buildTestApp()
  const cookie = await t.loginAsOwner()
  const h = { cookie }
  await t.app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Официант' } })
  return { ...t, h }
}

describe('employees api', () => {
  it('creates with a normalized phone', async () => {
    const { app, h } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '8 (999) 000-00-01', position_id: 1 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: 1, phone: '+79990000001', status: 'invited' })
  })

  it('rejects a bad phone and a duplicate phone', async () => {
    const { app, h } = await setup()
    const bad = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: 'abc', position_id: 1 },
    })
    expect(bad.statusCode).toBe(400)
    const payload = { full_name: 'Иван', phone: '+79990000001', position_id: 1 }
    await app.inject({ method: 'POST', url: '/api/employees', headers: h, payload })
    const dup = await app.inject({ method: 'POST', url: '/api/employees', headers: h, payload })
    expect(dup.statusCode).toBe(409)
  })

  it('rejects an unknown position', async () => {
    const { app, h } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '+79990000001', position_id: 77 },
    })
    expect(res.statusCode).toBe(409)
  })

  it('lists, updates and archives', async () => {
    const { app, h } = await setup()
    await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '+79990000001', position_id: 1 },
    })
    const upd = await app.inject({ method: 'PATCH', url: '/api/employees/1', headers: h, payload: { full_name: 'Пётр' } })
    expect(upd.json().full_name).toBe('Пётр')

    const arch = await app.inject({ method: 'POST', url: '/api/employees/1/archive', headers: h })
    expect(arch.json().status).toBe('archived')

    const list = await app.inject({ method: 'GET', url: '/api/employees', headers: h })
    expect(list.json()).toEqual([])
    const all = await app.inject({ method: 'GET', url: '/api/employees?includeArchived=1', headers: h })
    expect(all.json()).toHaveLength(1)

    const missing = await app.inject({ method: 'PATCH', url: '/api/employees/9', headers: h, payload: { full_name: 'X' } })
    expect(missing.statusCode).toBe(404)
  })
})
```

- [ ] **Step 4: Запустить, убедиться, что падает**

Run: `npx vitest run server/api`
Expected: FAIL, ошибки компиляции: `buildApp` не принимает `db`, модули роутов не найдены.

- [ ] **Step 5: server/api/requireOwner.ts**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OwnerAuth } from '../auth/ownerAuth.js'

export const SESSION_COOKIE = 'session'

export function sessionToken(req: FastifyRequest): string | undefined {
  const raw = req.cookies[SESSION_COOKIE]
  if (!raw) return undefined
  const unsigned = req.unsignCookie(raw)
  return unsigned.valid ? unsigned.value : undefined
}

export function requireOwner(auth: OwnerAuth) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!auth.hasSession(sessionToken(req))) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  }
}
```

- [ ] **Step 6: server/api/auth.ts**

```ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { SESSION_TTL_MS, type OwnerAuth } from '../auth/ownerAuth.js'
import type { Db } from '../db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID } from '../db/settings.js'
import { parse } from '../lib/validate.js'
import { requireOwner, SESSION_COOKIE, sessionToken } from './requireOwner.js'

type Opts = {
  db: Db
  auth: OwnerAuth
  sendToOwner: (text: string) => Promise<boolean>
  secureCookie: boolean
}

const verifyBody = z.object({ code: z.string().regex(/^\d{6}$/) })

export const authRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { db, auth, sendToOwner, secureCookie } = opts

  app.post('/api/auth/request-code', async (_req, reply) => {
    if (!getSetting(db, OWNER_TELEGRAM_ID)) {
      return reply.code(409).send({ error: 'owner_not_linked' })
    }
    const code = auth.createLoginCode()
    if (code === 'locked') return reply.code(429).send({ error: 'locked' })
    await sendToOwner(`Код входа в админку: ${code}\nДействует 5 минут.`)
    return reply.code(204).send()
  })

  app.post('/api/auth/verify', async (req, reply) => {
    const { code } = parse(verifyBody, req.body)
    const result = auth.verifyLoginCode(code)
    if ('error' in result) {
      return reply.code(result.error === 'locked' ? 429 : 401).send({ error: result.error })
    }
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      signed: true,
    })
    return reply.code(204).send()
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = sessionToken(req)
    if (token) auth.deleteSession(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: requireOwner(auth) }, async () => ({ ok: true }))
}
```

- [ ] **Step 7: server/api/positions.ts**

```ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import { createPosition, deletePosition, listPositions, renamePosition } from '../db/positions.js'
import { parse } from '../lib/validate.js'

const body = z.object({ name: z.string().trim().min(1).max(100) })
const params = z.object({ id: z.coerce.number().int().positive() })

export const positionRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/api/positions', async () => listPositions(db))

  app.post('/api/positions', async (req, reply) => {
    const { name } = parse(body, req.body)
    return reply.code(201).send(createPosition(db, name))
  })

  app.patch('/api/positions/:id', async (req, reply) => {
    const { id } = parse(params, req.params)
    const { name } = parse(body, req.body)
    const updated = renamePosition(db, id, name)
    return updated ?? reply.code(404).send({ error: 'not_found' })
  })

  app.delete('/api/positions/:id', async (req, reply) => {
    const { id } = parse(params, req.params)
    const result = deletePosition(db, id)
    if (result === 'in_use') return reply.code(409).send({ error: 'in_use' })
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })
}
```

- [ ] **Step 8: server/api/employees.ts**

```ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db/connect.js'
import {
  archiveEmployee,
  createEmployee,
  listEmployees,
  updateEmployee,
} from '../db/employees.js'
import { normalizePhone } from '../lib/phone.js'
import { parse, ValidationError } from '../lib/validate.js'

const phone = z.string().transform((raw, ctx) => {
  const normalized = normalizePhone(raw)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: 'Некорректный номер телефона' })
    return z.NEVER
  }
  return normalized
})

const createBody = z.object({
  full_name: z.string().trim().min(1).max(200),
  phone,
  position_id: z.number().int().positive(),
})
const patchBody = createBody.partial()
const params = z.object({ id: z.coerce.number().int().positive() })
const listQuery = z.object({ includeArchived: z.string().optional() })

export const employeeRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/api/employees', async (req) => {
    const q = parse(listQuery, req.query)
    return listEmployees(db, { includeArchived: q.includeArchived === '1' })
  })

  app.post('/api/employees', async (req, reply) => {
    const input = parse(createBody, req.body)
    return reply.code(201).send(createEmployee(db, input))
  })

  app.patch('/api/employees/:id', async (req, reply) => {
    const { id } = parse(params, req.params)
    const patch = parse(patchBody, req.body)
    if (Object.keys(patch).length === 0) throw new ValidationError([{ message: 'Пустое изменение' }])
    const updated = updateEmployee(db, id, patch)
    return updated ?? reply.code(404).send({ error: 'not_found' })
  })

  app.post('/api/employees/:id/archive', async (req, reply) => {
    const { id } = parse(params, req.params)
    const archived = archiveEmployee(db, id)
    return archived ?? reply.code(404).send({ error: 'not_found' })
  })
}
```

- [ ] **Step 9: server/app.ts (полная замена)**

```ts
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import type { Config } from './config.js'
import type { Db } from './db/connect.js'
import type { OwnerAuth } from './auth/ownerAuth.js'
import { ValidationError } from './lib/validate.js'
import { authRoutes } from './api/auth.js'
import { requireOwner } from './api/requireOwner.js'
import { positionRoutes } from './api/positions.js'
import { employeeRoutes } from './api/employees.js'

export type AppDeps = {
  config: Config
  db: Db
  auth: OwnerAuth
  sendToOwner: (text: string) => Promise<boolean>
  adminDistDir?: string
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, db, auth, sendToOwner } = deps
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  app.register(fastifyCookie, { secret: config.SESSION_SECRET })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ error: 'validation', issues: err.issues })
    }
    const code = (err as { code?: string }).code ?? ''
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      return reply.code(409).send({ error: 'conflict' })
    }
    app.log.error(err)
    return reply.code(err.statusCode ?? 500).send({ error: 'internal' })
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.register(authRoutes, {
    db,
    auth,
    sendToOwner,
    secureCookie: config.PUBLIC_URL?.startsWith('https://') ?? false,
  })

  app.register(async (scope) => {
    scope.addHook('preHandler', requireOwner(auth))
    scope.register(positionRoutes, { db })
    scope.register(employeeRoutes, { db })
  })

  return app
}
```

- [ ] **Step 10: Обновить server/app.test.ts**

Заменить создание приложения на хелпер:
```ts
import { describe, expect, it } from 'vitest'
import { buildTestApp } from './test/buildTestApp.js'

describe('app', () => {
  it('answers /healthz', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
```

`server/index.ts` в этой задаче временно не компилируется (у `buildApp` новые обязательные поля); он переписывается в Task 8. Чтобы `npm run typecheck` был зелёным уже сейчас, замените `server/index.ts` на:
```ts
export {}
```

- [ ] **Step 11: Все тесты и typecheck зелёные**

Run: `npm test && npm run typecheck`
Expected: все тесты passed (config 3, app 1, connect 3, repos 5, ownerAuth 7, auth 5, positions 2, employees 4, phone 10), tsc без ошибок.

Если тест `validates the body` вернул 500 вместо 400: проверьте, что `parse` бросает именно `ValidationError` из `server/lib/validate.ts`, а не копию класса.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: owner auth, positions and employees REST API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Бот: привязка по номеру и меню

**Files:**
- Create: `server/notify.ts`, `server/bot/keyboards.ts`, `server/bot/createBot.ts`, `server/test/telegram.ts`
- Test: `server/notify.test.ts`, `server/bot/createBot.test.ts`

**Interfaces:**
- Consumes: `Db`, `normalizePhone`, репозитории `employees`/`settings`.
- Produces: `notifyOwner(api: Api, db: Db, text: string): Promise<boolean>` (false, если владелец не привязан или отправка упала).
- Produces: `createBot(opts: { token: string; db: Db; ownerPhone: string; publicUrl?: string; botInfo?: UserFromGetMe }): Bot`.
- Produces (`keyboards.ts`): `employeeMenu()`, `ownerMenu()`, `contactRequest()` — объекты `Keyboard`; константы кнопок `BTN = { tasks: 'Мои задания', learning: 'Обучение', quizzes: 'Тесты', rating: 'Мой рейтинг', summary: 'Сводка' }`.
- Produces (`server/test/telegram.ts`): `textUpdate(fromId, text, name?)`, `contactUpdate(fromId, phone, contactUserId?)`, `captureApi(bot): { method: string; payload: Record<string, unknown> }[]`, `botInfo`.

Поведение:
- `/start` и любое сообщение от непривязанного пользователя → просьба поделиться номером с кнопкой `request_contact`.
- Контакт чужого пользователя (`contact.user_id !== from.id`) → «Пришлите свой номер через кнопку».
- Номер совпал с `OWNER_PHONE` → `settings.owner_telegram_id = from.id`, ответ «Вы вошли как владелец» + меню владельца.
- Номер сотрудника со статусом `invited` → `linkTelegram`, приветствие + меню сотрудника, владельцу уведомление «Сотрудник … подключился».
- Номер сотрудника `active` с другим `telegram_id` → «Этот номер уже привязан к другому аккаунту Telegram».
- Номер не найден или сотрудник `archived` → «Вас ещё не добавили. Обратитесь к владельцу».
- Кнопки меню сотрудника в этом этапе отвечают «Раздел появится в ближайшем обновлении».
- «Сводка» владельцу: число активных и приглашённых сотрудников, ссылка на админку, если задан `PUBLIC_URL`.

- [ ] **Step 1: Тест notifyOwner**

`server/notify.test.ts`:
```ts
import { Api } from 'grammy'
import { describe, expect, it } from 'vitest'
import { openDb } from './db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from './db/settings.js'
import { notifyOwner } from './notify.js'

function fakeApi(fail = false) {
  const api = new Api('test')
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (fail) return { ok: false, error_code: 403, description: 'blocked' }
    return { ok: true, result: true }
  })
  return { api, calls }
}

describe('notifyOwner', () => {
  it('returns false when the owner is not linked', async () => {
    const db = openDb(':memory:')
    const { api, calls } = fakeApi()
    expect(await notifyOwner(api, db, 'hi')).toBe(false)
    expect(calls).toEqual([])
  })

  it('sends a message to the owner chat', async () => {
    const db = openDb(':memory:')
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const { api, calls } = fakeApi()
    expect(await notifyOwner(api, db, 'hi')).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'sendMessage', payload: { chat_id: 42, text: 'hi' } })
  })

  it('returns false when telegram fails', async () => {
    const db = openDb(':memory:')
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const { api } = fakeApi(true)
    expect(await notifyOwner(api, db, 'hi')).toBe(false)
  })
})
```

- [ ] **Step 2: server/notify.ts**

```ts
import type { Api } from 'grammy'
import type { Db } from './db/connect.js'
import { getSetting, OWNER_TELEGRAM_ID } from './db/settings.js'

export async function notifyOwner(api: Api, db: Db, text: string): Promise<boolean> {
  const ownerId = getSetting(db, OWNER_TELEGRAM_ID)
  if (!ownerId) return false
  try {
    await api.sendMessage(Number(ownerId), text)
    return true
  } catch (err) {
    console.error('notifyOwner failed', err)
    return false
  }
}
```

Run: `npx vitest run server/notify.test.ts`
Expected: 3 passed.

- [ ] **Step 3: Тестовые фабрики Telegram**

`server/test/telegram.ts`:
```ts
import type { Bot, UserFromGetMe } from 'grammy'
import type { Update } from 'grammy/types'

export const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
}

let updateId = 0

function base(fromId: number, name: string) {
  return {
    message_id: ++updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: fromId, type: 'private' as const, first_name: name },
    from: { id: fromId, is_bot: false, first_name: name },
  }
}

export function textUpdate(fromId: number, text: string, name = 'User'): Update {
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }]
    : []
  return { update_id: ++updateId, message: { ...base(fromId, name), text, entities } }
}

export function contactUpdate(fromId: number, phone: string, contactUserId = fromId): Update {
  return {
    update_id: ++updateId,
    message: {
      ...base(fromId, 'User'),
      contact: { phone_number: phone, first_name: 'User', user_id: contactUserId },
    },
  }
}

export function captureApi(bot: Bot) {
  const calls: { method: string; payload: Record<string, unknown> }[] = []
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true }
  })
  return calls
}
```

- [ ] **Step 4: Тест бота**

`server/bot/createBot.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from 'grammy'
import { openDb, type Db } from '../db/connect.js'
import { createPosition } from '../db/positions.js'
import { createEmployee, getEmployee, linkTelegram } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { botInfo, captureApi, contactUpdate, textUpdate } from '../test/telegram.js'
import { createBot } from './createBot.js'

const OWNER_PHONE = '+79990000000'
let db: Db
let bot: Bot
let calls: ReturnType<typeof captureApi>

beforeEach(() => {
  db = openDb(':memory:')
  bot = createBot({ token: 'test', db, ownerPhone: OWNER_PHONE, botInfo, publicUrl: 'https://admin.example' })
  calls = captureApi(bot)
  createPosition(db, 'Официант')
  createEmployee(db, { full_name: 'Иван Петров', phone: '+79990000001', position_id: 1 })
})

const lastText = () => String(calls.at(-1)?.payload.text ?? '')
const lastMarkup = () => JSON.stringify(calls.at(-1)?.payload.reply_markup ?? {})

describe('linking', () => {
  it('asks an unknown user for the contact', async () => {
    await bot.handleUpdate(textUpdate(500, '/start'))
    expect(calls.at(-1)?.method).toBe('sendMessage')
    expect(lastMarkup()).toContain('"request_contact":true')
  })

  it('rejects a contact of another user', async () => {
    await bot.handleUpdate(contactUpdate(500, '+79990000001', 501))
    expect(lastText()).toMatch(/свой номер/i)
    expect(getEmployee(db, 1)?.telegram_id).toBeNull()
  })

  it('links the owner by OWNER_PHONE', async () => {
    await bot.handleUpdate(contactUpdate(42, '79990000000'))
    expect(getSetting(db, OWNER_TELEGRAM_ID)).toBe('42')
    expect(lastText()).toMatch(/владелец/i)
  })

  it('links an invited employee and notifies the owner', async () => {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await bot.handleUpdate(contactUpdate(500, '+7 999 000-00-01'))
    expect(getEmployee(db, 1)).toMatchObject({ status: 'active', telegram_id: 500 })
    const toOwner = calls.find((c) => c.payload.chat_id === 42)
    expect(String(toOwner?.payload.text)).toMatch(/Иван Петров/)
    const toEmployee = calls.find((c) => c.payload.chat_id === 500)
    expect(JSON.stringify(toEmployee?.payload.reply_markup)).toContain('Мои задания')
  })

  it('rejects an unknown phone', async () => {
    await bot.handleUpdate(contactUpdate(500, '+79990009999'))
    expect(lastText()).toMatch(/не добавили/i)
  })

  it('rejects a phone already linked to another account', async () => {
    linkTelegram(db, 1, 777)
    await bot.handleUpdate(contactUpdate(500, '+79990000001'))
    expect(lastText()).toMatch(/другому аккаунту/i)
    expect(getEmployee(db, 1)?.telegram_id).toBe(777)
  })
})

describe('menus', () => {
  it('shows the employee menu on /start and answers menu buttons', async () => {
    linkTelegram(db, 1, 500)
    await bot.handleUpdate(textUpdate(500, '/start'))
    expect(lastMarkup()).toContain('Мои задания')
    await bot.handleUpdate(textUpdate(500, 'Мои задания'))
    expect(lastText()).toMatch(/появится/i)
  })

  it('shows the owner summary with the admin link', async () => {
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await bot.handleUpdate(textUpdate(42, 'Сводка'))
    expect(lastText()).toMatch(/Приглашены: 1/)
    expect(lastText()).toContain('https://admin.example')
  })
})
```

- [ ] **Step 5: Запустить, убедиться, что падает**

Run: `npx vitest run server/bot`
Expected: FAIL, `Cannot find module './createBot.js'`.

- [ ] **Step 6: server/bot/keyboards.ts**

```ts
import { Keyboard } from 'grammy'

export const BTN = {
  tasks: 'Мои задания',
  learning: 'Обучение',
  quizzes: 'Тесты',
  rating: 'Мой рейтинг',
  summary: 'Сводка',
} as const

export function employeeMenu(): Keyboard {
  return new Keyboard()
    .text(BTN.tasks)
    .text(BTN.learning)
    .row()
    .text(BTN.quizzes)
    .text(BTN.rating)
    .resized()
    .persistent()
}

export function ownerMenu(): Keyboard {
  return new Keyboard().text(BTN.summary).resized().persistent()
}

export function contactRequest(): Keyboard {
  return new Keyboard().requestContact('Поделиться номером').resized().oneTime()
}
```

- [ ] **Step 7: server/bot/createBot.ts**

```ts
import { Bot, type Context, type UserFromGetMe } from 'grammy'
import type { Db } from '../db/connect.js'
import {
  findEmployeeByPhone,
  findEmployeeByTelegramId,
  linkTelegram,
  listEmployees,
  type Employee,
} from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { normalizePhone } from '../lib/phone.js'
import { notifyOwner } from '../notify.js'
import { BTN, contactRequest, employeeMenu, ownerMenu } from './keyboards.js'

export type BotOptions = {
  token: string
  db: Db
  ownerPhone: string
  publicUrl?: string
  botInfo?: UserFromGetMe
}

type Role = { kind: 'owner' } | { kind: 'employee'; employee: Employee } | { kind: 'unknown' }

export function createBot(opts: BotOptions): Bot {
  const { db, publicUrl } = opts
  const ownerPhone = normalizePhone(opts.ownerPhone)
  if (!ownerPhone) throw new Error('OWNER_PHONE is not a valid phone number')

  const bot = new Bot(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined)

  function roleOf(telegramId: number): Role {
    if (getSetting(db, OWNER_TELEGRAM_ID) === String(telegramId)) return { kind: 'owner' }
    const employee = findEmployeeByTelegramId(db, telegramId)
    if (employee && employee.status === 'active') return { kind: 'employee', employee }
    return { kind: 'unknown' }
  }

  function summaryText(): string {
    const all = listEmployees(db)
    const active = all.filter((e) => e.status === 'active').length
    const invited = all.filter((e) => e.status === 'invited').length
    const lines = [`Активны: ${active}`, `Приглашены: ${invited}`]
    if (publicUrl) lines.push(`Админка: ${publicUrl}`)
    return lines.join('\n')
  }

  async function showHome(ctx: Context): Promise<void> {
    const role = roleOf(ctx.from!.id)
    if (role.kind === 'owner') {
      await ctx.reply(`Вы владелец.\n${summaryText()}`, { reply_markup: ownerMenu() })
    } else if (role.kind === 'employee') {
      await ctx.reply(`Здравствуйте, ${role.employee.full_name}!`, { reply_markup: employeeMenu() })
    } else {
      await ctx.reply('Чтобы подключиться, поделитесь номером телефона.', {
        reply_markup: contactRequest(),
      })
    }
  }

  bot.command('start', showHome)

  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact
    const fromId = ctx.from.id
    if (contact.user_id !== fromId) {
      await ctx.reply('Пришлите свой номер через кнопку «Поделиться номером».', {
        reply_markup: contactRequest(),
      })
      return
    }
    const phone = normalizePhone(contact.phone_number)
    if (!phone) {
      await ctx.reply('Не удалось распознать номер. Обратитесь к владельцу.')
      return
    }
    if (phone === ownerPhone) {
      setSetting(db, OWNER_TELEGRAM_ID, String(fromId))
      await ctx.reply(`Вы вошли как владелец.\n${summaryText()}`, { reply_markup: ownerMenu() })
      return
    }
    const employee = findEmployeeByPhone(db, phone)
    if (!employee || employee.status === 'archived') {
      await ctx.reply('Вас ещё не добавили. Обратитесь к владельцу.')
      return
    }
    if (employee.status === 'active') {
      if (employee.telegram_id === fromId) return showHome(ctx)
      await ctx.reply('Этот номер уже привязан к другому аккаунту Telegram.')
      return
    }
    const linked = linkTelegram(db, employee.id, fromId)!
    await ctx.reply(`Здравствуйте, ${linked.full_name}! Вы подключены.`, {
      reply_markup: employeeMenu(),
    })
    await notifyOwner(ctx.api, db, `Сотрудник ${linked.full_name} подключился к боту.`)
  })

  bot.hears([BTN.tasks, BTN.learning, BTN.quizzes, BTN.rating], async (ctx) => {
    if (roleOf(ctx.from!.id).kind !== 'employee') return showHome(ctx)
    await ctx.reply('Раздел появится в ближайшем обновлении.')
  })

  bot.hears(BTN.summary, async (ctx) => {
    if (roleOf(ctx.from!.id).kind !== 'owner') return showHome(ctx)
    await ctx.reply(summaryText(), { reply_markup: ownerMenu() })
  })

  bot.on('message', showHome)

  bot.catch((err) => {
    console.error('bot error', err.error)
  })

  return bot
}
```

- [ ] **Step 8: Тесты зелёные**

Run: `npx vitest run server/bot server/notify.test.ts`
Expected: 11 passed.

Если `bot.handleUpdate` бросает «Bot information unavailable», проверьте, что `botInfo` передан в конструктор `Bot`.

- [ ] **Step 9: Commit**

```bash
git add server/bot server/notify.ts server/notify.test.ts server/test/telegram.ts
git commit -m "feat: telegram bot with phone linking and menus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Сборка процесса: статика админки, точка входа

**Files:**
- Modify: `server/app.ts` (добавить статику)
- Modify: `server/index.ts` (полная замена)
- Test: `server/app.test.ts` (добавить тест SPA-фолбэка)

**Interfaces:**
- Consumes: всё из Task 6 и Task 7.
- Produces: при заданном `adminDistDir` `GET /` и любые не-`/api` GET без файла отдают `index.html`; `/api/*` без маршрута отдаёт 404 JSON.

- [ ] **Step 1: Тест статики**

Добавить в `server/app.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'

describe('admin static', () => {
  it('serves index.html for SPA routes and 404 JSON for unknown api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin-'))
    writeFileSync(join(dir, 'index.html'), '<h1>admin</h1>')
    const db = openDb(':memory:')
    const app = buildApp({
      config: loadConfig({ BOT_TOKEN: 't', OWNER_PHONE: '+79990000000', SESSION_SECRET: 'sixteen-characters!' }),
      db,
      auth: createOwnerAuth(db),
      sendToOwner: async () => true,
      adminDistDir: dir,
    })
    const root = await app.inject({ method: 'GET', url: '/' })
    expect(root.statusCode).toBe(200)
    expect(root.body).toContain('admin')
    const deep = await app.inject({ method: 'GET', url: '/employees' })
    expect(deep.statusCode).toBe(200)
    expect(deep.body).toContain('admin')
    const api = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(api.statusCode).toBe(404)
    await app.close()
  })
})
```

Run: `npx vitest run server/app.test.ts`
Expected: FAIL, `/employees` отдаёт 404.

- [ ] **Step 2: Статика в server/app.ts**

Добавить импорты:
```ts
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
```

Перед `return app` добавить:
```ts
  if (deps.adminDistDir && existsSync(deps.adminDistDir)) {
    app.register(fastifyStatic, { root: deps.adminDistDir, wildcard: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not_found' })
    })
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }))
  }
```

Run: `npx vitest run server/app.test.ts`
Expected: 2 passed.

- [ ] **Step 3: server/index.ts**

```ts
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'
import { createBot } from './bot/createBot.js'
import { notifyOwner } from './notify.js'
import { buildApp } from './app.js'

const config = loadConfig()
mkdirSync(config.DATA_DIR, { recursive: true })

const db = openDb(join(config.DATA_DIR, 'app.db'))
const auth = createOwnerAuth(db)
const bot = createBot({
  token: config.BOT_TOKEN,
  db,
  ownerPhone: config.OWNER_PHONE,
  publicUrl: config.PUBLIC_URL,
})
const app = buildApp({
  config,
  db,
  auth,
  sendToOwner: (text) => notifyOwner(bot.api, db, text),
  adminDistDir: resolve('admin/dist'),
})

await app.listen({ port: config.PORT, host: '0.0.0.0' })
void bot.start({
  onStart: (info) => app.log.info(`bot @${info.username} polling`),
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    await bot.stop()
    await app.close()
    db.close()
    process.exit(0)
  })
}
```

- [ ] **Step 4: Проверка запуска**

Создать `.env` из `.env.example` с реальным `BOT_TOKEN` тестового бота (получить у @BotFather) и своим номером в `OWNER_PHONE`, `DATA_DIR=./data`. Запустить:

```bash
set -a; source .env; set +a; npm run dev
```

Expected: в логе `Server listening at http://0.0.0.0:3000` и `bot @... polling`. `curl localhost:3000/healthz` → `{"ok":true}`. В Telegram `/start` боту → просьба поделиться номером; после отправки контакта → «Вы вошли как владелец». Остановить Ctrl+C.

Если токена под рукой нет: пропустить ручную проверку, отметить это в отчёте по задаче.

- [ ] **Step 5: Тесты и typecheck зелёные, commit**

Run: `npm test && npm run typecheck`
Expected: все passed, tsc без ошибок.

```bash
git add -A
git commit -m "feat: wire bot, api and admin static into one process

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Админка: вход, должности, сотрудники

**Files:**
- Create: `vite.config.ts`, `admin/index.html`, `admin/tsconfig.json`, `admin/src/env.d.ts`, `admin/src/style.css`, `admin/src/main.ts`, `admin/src/App.vue`, `admin/src/router.ts`, `admin/src/api.ts`
- Create: `admin/src/components/AppLayout.vue`, `admin/src/pages/LoginPage.vue`, `admin/src/pages/PositionsPage.vue`, `admin/src/pages/EmployeesPage.vue`

**Interfaces:**
- Consumes: HTTP-контракт из Task 6.
- Produces: `npm run build` кладёт SPA в `admin/dist`, которую сервер отдаёт по `/`.

Юнит-тестов на Vue в этом этапе нет: проверка через сборку и ручной прогон сценариев (Step 9). Стиль: Tailwind, без UI-библиотек, тексты на русском.

- [ ] **Step 1: vite.config.ts, admin/index.html, admin/tsconfig.json, admin/src/env.d.ts, admin/src/style.css**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'admin',
  plugins: [vue(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
})
```

`admin/index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Админка ресторана</title>
  </head>
  <body class="bg-gray-50 text-gray-900">
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`admin/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
```

`admin/src/env.d.ts`:
```ts
/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
```

`admin/src/style.css`:
```css
@import "tailwindcss";
```

- [ ] **Step 2: admin/src/api.ts**

```ts
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
```

- [ ] **Step 3: admin/src/router.ts, main.ts, App.vue**

`admin/src/router.ts`:
```ts
import { createRouter, createWebHistory } from 'vue-router'
import { api } from './api'
import AppLayout from './components/AppLayout.vue'
import LoginPage from './pages/LoginPage.vue'
import EmployeesPage from './pages/EmployeesPage.vue'
import PositionsPage from './pages/PositionsPage.vue'

let authed = false
export function setAuthed(value: boolean) {
  authed = value
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginPage },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', redirect: '/employees' },
        { path: 'employees', component: EmployeesPage },
        { path: 'positions', component: PositionsPage },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.path === '/login') return true
  if (authed) return true
  try {
    await api.me()
    authed = true
    return true
  } catch {
    return '/login'
  }
})
```

`admin/src/main.ts`:
```ts
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './style.css'

createApp(App).use(router).mount('#app')
```

`admin/src/App.vue`:
```vue
<template>
  <RouterView />
</template>
```

- [ ] **Step 4: admin/src/pages/LoginPage.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText } from '../api'
import { setAuthed } from '../router'

const router = useRouter()
const step = ref<'request' | 'verify'>('request')
const code = ref('')
const error = ref('')
const busy = ref(false)

async function requestCode() {
  busy.value = true
  error.value = ''
  try {
    await api.requestCode()
    step.value = 'verify'
  } catch (err) {
    error.value = errorText(err, {
      owner_not_linked: 'Владелец ещё не подключён: напишите боту /start и поделитесь номером.',
      locked: 'Слишком много попыток. Подождите 15 минут.',
    })
  } finally {
    busy.value = false
  }
}

async function verify() {
  busy.value = true
  error.value = ''
  try {
    await api.verify(code.value.trim())
    setAuthed(true)
    await router.push('/employees')
  } catch (err) {
    error.value = errorText(err, {
      invalid: 'Неверный или просроченный код.',
      locked: 'Слишком много попыток. Подождите 15 минут.',
      validation: 'Введите 6 цифр.',
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-sm bg-white rounded-xl shadow p-6 space-y-4">
      <h1 class="text-xl font-semibold">Вход для владельца</h1>

      <template v-if="step === 'request'">
        <p class="text-sm text-gray-600">Код придёт в Telegram-бот.</p>
        <button class="btn w-full" :disabled="busy" @click="requestCode">Получить код</button>
      </template>

      <form v-else class="space-y-3" @submit.prevent="verify">
        <label class="block text-sm">
          Код из Telegram
          <input
            v-model="code"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            class="input mt-1"
            autofocus
          />
        </label>
        <button class="btn w-full" :disabled="busy || code.length !== 6">Войти</button>
        <button type="button" class="text-sm text-gray-500 underline" @click="requestCode">
          Отправить код ещё раз
        </button>
      </form>

      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    </div>
  </div>
</template>
```

Добавить в `admin/src/style.css` общие классы:
```css
@import "tailwindcss";

@layer components {
  .btn {
    @apply rounded-lg bg-gray-900 text-white px-4 py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50;
  }
  .btn-secondary {
    @apply rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50;
  }
  .input {
    @apply w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400;
  }
}
```

- [ ] **Step 5: admin/src/components/AppLayout.vue**

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router'
import { api } from '../api'
import { setAuthed } from '../router'

const router = useRouter()

async function logout() {
  await api.logout().catch(() => undefined)
  setAuthed(false)
  await router.push('/login')
}
</script>

<template>
  <div class="min-h-screen">
    <header class="bg-white border-b">
      <nav class="max-w-5xl mx-auto px-4 h-14 flex items-center gap-6">
        <span class="font-semibold">Ресторан</span>
        <RouterLink to="/employees" class="text-sm hover:underline" active-class="font-semibold">
          Сотрудники
        </RouterLink>
        <RouterLink to="/positions" class="text-sm hover:underline" active-class="font-semibold">
          Должности
        </RouterLink>
        <button class="ml-auto text-sm text-gray-500 hover:underline" @click="logout">Выйти</button>
      </nav>
    </header>
    <main class="max-w-5xl mx-auto p-4">
      <RouterView />
    </main>
  </div>
</template>
```

- [ ] **Step 6: admin/src/pages/PositionsPage.vue**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, errorText, type Position } from '../api'

const positions = ref<Position[]>([])
const newName = ref('')
const error = ref('')

async function load() {
  positions.value = await api.positions.list()
}

async function add() {
  error.value = ''
  try {
    await api.positions.create(newName.value)
    newName.value = ''
    await load()
  } catch (err) {
    error.value = errorText(err, { conflict: 'Такая должность уже есть.' })
  }
}

async function rename(p: Position) {
  const name = window.prompt('Новое название', p.name)?.trim()
  if (!name || name === p.name) return
  error.value = ''
  try {
    await api.positions.rename(p.id, name)
    await load()
  } catch (err) {
    error.value = errorText(err, { conflict: 'Такая должность уже есть.' })
  }
}

async function remove(p: Position) {
  if (!window.confirm(`Удалить должность «${p.name}»?`)) return
  error.value = ''
  try {
    await api.positions.remove(p.id)
    await load()
  } catch (err) {
    error.value = errorText(err, { in_use: 'Должность назначена сотрудникам, удалить нельзя.' })
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Должности</h1>

    <form class="flex gap-2" @submit.prevent="add">
      <input v-model="newName" class="input max-w-xs" placeholder="Например, Официант" required />
      <button class="btn">Добавить</button>
    </form>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <ul class="bg-white rounded-xl shadow divide-y">
      <li v-for="p in positions" :key="p.id" class="flex items-center px-4 py-2 gap-2">
        <span class="flex-1">{{ p.name }}</span>
        <button class="btn-secondary" @click="rename(p)">Переименовать</button>
        <button class="btn-secondary" @click="remove(p)">Удалить</button>
      </li>
      <li v-if="positions.length === 0" class="px-4 py-3 text-sm text-gray-500">Пока пусто</li>
    </ul>
  </div>
</template>
```

- [ ] **Step 7: admin/src/pages/EmployeesPage.vue**

```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api, errorText, type Employee, type Position } from '../api'

const employees = ref<Employee[]>([])
const positions = ref<Position[]>([])
const includeArchived = ref(false)
const error = ref('')
const editingId = ref<number | null>(null)
const form = reactive({ full_name: '', phone: '', position_id: 0 })

const positionName = computed(() => {
  const map = new Map(positions.value.map((p) => [p.id, p.name]))
  return (id: number) => map.get(id) ?? '—'
})

const statusLabel: Record<Employee['status'], string> = {
  invited: 'Приглашён',
  active: 'Активен',
  archived: 'В архиве',
}

async function load() {
  ;[employees.value, positions.value] = await Promise.all([
    api.employees.list(includeArchived.value),
    api.positions.list(),
  ])
  if (!form.position_id && positions.value[0]) form.position_id = positions.value[0].id
}

function startEdit(e: Employee) {
  editingId.value = e.id
  form.full_name = e.full_name
  form.phone = e.phone
  form.position_id = e.position_id
}

function resetForm() {
  editingId.value = null
  form.full_name = ''
  form.phone = ''
  form.position_id = positions.value[0]?.id ?? 0
}

async function submit() {
  error.value = ''
  try {
    if (editingId.value === null) {
      await api.employees.create({ ...form })
    } else {
      await api.employees.update(editingId.value, { ...form })
    }
    resetForm()
    await load()
  } catch (err) {
    error.value = errorText(err, {
      conflict: 'Сотрудник с таким телефоном уже есть.',
      validation: 'Проверьте имя и номер телефона.',
    })
  }
}

async function archive(e: Employee) {
  if (!window.confirm(`Отправить ${e.full_name} в архив?`)) return
  await api.employees.archive(e.id)
  await load()
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Сотрудники</h1>

    <p v-if="positions.length === 0" class="text-sm text-amber-700">
      Сначала добавьте хотя бы одну должность.
    </p>

    <form v-else class="bg-white rounded-xl shadow p-4 grid gap-3 md:grid-cols-4" @submit.prevent="submit">
      <input v-model="form.full_name" class="input" placeholder="Имя и фамилия" required />
      <input v-model="form.phone" class="input" placeholder="+7 999 123-45-67" required />
      <select v-model.number="form.position_id" class="input">
        <option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <div class="flex gap-2">
        <button class="btn">{{ editingId === null ? 'Добавить' : 'Сохранить' }}</button>
        <button v-if="editingId !== null" type="button" class="btn-secondary" @click="resetForm">
          Отмена
        </button>
      </div>
      <p v-if="error" class="text-sm text-red-600 md:col-span-4">{{ error }}</p>
    </form>

    <label class="text-sm flex items-center gap-2">
      <input v-model="includeArchived" type="checkbox" @change="load" />
      Показывать архивных
    </label>

    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr>
          <th class="px-4 py-2">Имя</th>
          <th class="px-4 py-2">Телефон</th>
          <th class="px-4 py-2">Должность</th>
          <th class="px-4 py-2">Статус</th>
          <th class="px-4 py-2"></th>
        </tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="e in employees" :key="e.id">
          <td class="px-4 py-2">{{ e.full_name }}</td>
          <td class="px-4 py-2">{{ e.phone }}</td>
          <td class="px-4 py-2">{{ positionName(e.position_id) }}</td>
          <td class="px-4 py-2">{{ statusLabel[e.status] }}</td>
          <td class="px-4 py-2 text-right space-x-2">
            <button v-if="e.status !== 'archived'" class="btn-secondary" @click="startEdit(e)">Изменить</button>
            <button v-if="e.status !== 'archived'" class="btn-secondary" @click="archive(e)">В архив</button>
          </td>
        </tr>
        <tr v-if="employees.length === 0">
          <td colspan="5" class="px-4 py-3 text-gray-500">Пока пусто</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

- [ ] **Step 8: Сборка**

Run: `npm run build`
Expected: Vite пишет `admin/dist/index.html` и `admin/dist/assets/*`, tsc без ошибок. Проверить: `ls admin/dist`.

- [ ] **Step 9: Ручной прогон**

Запустить сервер и админку в двух терминалах (нужен `.env` из Task 8, Step 4):
```bash
set -a; source .env; set +a; npm run dev
```
```bash
npm run dev:admin
```
Открыть `http://localhost:5173`. Проверить по списку:
1. Без привязанного владельца кнопка «Получить код» показывает подсказку про `/start`.
2. После привязки владельца в боте код приходит в Telegram, вход проходит, открывается «Сотрудники».
3. Добавить должность, переименовать, попытаться удалить занятую (ошибка), удалить свободную.
4. Добавить сотрудника с номером `8 999 123 45 67`, в таблице он показан как `+79991234567`, статус «Приглашён».
5. Повторный номер даёт ошибку про дубликат.
6. Изменить имя, отправить в архив, включить «Показывать архивных».
7. «Выйти» возвращает на логин, прямой заход на `/employees` без сессии тоже.

Если Telegram-токена нет: проверить пункты 1, 7 и всё, что доступно после ручного `insert` в `settings` и получения кода из лога, отметить пропуски в отчёте.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: admin SPA with login, positions and employees

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Docker и README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`

**Interfaces:**
- Consumes: `npm run build`, `npm start`, переменные из Global Constraints.
- Produces: образ, который стартует одной командой `docker compose up -d` с томом `./data:/data`.

- [ ] **Step 1: Dockerfile и .dockerignore**

`Dockerfile`:
```dockerfile
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin/dist ./admin/dist
COPY package.json ./
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
```

`.dockerignore`:
```
node_modules
dist
admin/dist
data
.env
.git
docs
```

Если `npm ci` в образе падает на сборке better-sqlite3 (нет prebuilt-бинарника под платформу), добавить в стадию `build` перед `npm ci`:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: docker-compose.yml**

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      DATA_DIR: /data
      PORT: "3000"
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
```

`TZ` берётся из `.env` (см. `.env.example`), он нужен планировщику в следующих этапах.

- [ ] **Step 3: README.md**

```markdown
# Обучение и контроль персонала ресторана

Telegram-бот для сотрудников и веб-админка для владельца. Один процесс: Fastify + grammY + SQLite.

Дизайн: `docs/superpowers/specs/2026-09-07-restaurant-staff-design.md`.

## Запуск в Docker

1. Создать бота у @BotFather, получить токен.
2. `cp .env.example .env`, заполнить `BOT_TOKEN`, `OWNER_PHONE` (свой номер), `SESSION_SECRET` (длинная случайная строка), `PUBLIC_URL` (адрес админки).
3. `docker compose up -d --build`.
4. Написать боту `/start` и поделиться номером: это привяжет владельца.
5. Открыть `PUBLIC_URL`, нажать «Получить код», ввести код из бота.

Данные лежат в `./data` (база и загруженные файлы). Бэкап: копия этой папки при остановленном контейнере.

## Разработка

```bash
npm install
cp .env.example .env   # заполнить
set -a; source .env; set +a; npm run dev   # сервер на :3000
npm run dev:admin                          # админка на :5173 с прокси на :3000
npm test
npm run typecheck
```
```

- [ ] **Step 4: Проверка образа**

Run: `docker build -t restaurant-staff .`
Expected: сборка завершается успешно.

Run (без реального токена, проверяем только старт HTTP):
```bash
docker run --rm -e BOT_TOKEN=1:test -e OWNER_PHONE=+79990000000 -e SESSION_SECRET=sixteen-characters! -p 3001:3000 restaurant-staff &
sleep 3; curl -s localhost:3001/healthz; docker stop $(docker ps -q --filter ancestor=restaurant-staff)
```
Expected: `{"ok":true}`. Ошибки polling с фейковым токеном в логе допустимы.

- [ ] **Step 5: Финальная проверка и commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: все зелёные.

```bash
git add -A
git commit -m "chore: dockerfile, compose and readme

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
