# Архив и удаление шаблонов заданий. План (дополнение к этапу 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Владелец может отправить любое задание (разовое или регулярное) в архив и вернуть обратно, а ошибочно созданное задание без истории удалить.

**Architecture:** Архив = существующее поле `active` шаблона; «Остановить/Возобновить» переименовываются в «В архив/Вернуть» и работают для всех шаблонов. Удаление — новая репозиторная функция и `DELETE`-роут, отказывающие при наличии экземпляров.

## Global Constraints

- Те же, что в `docs/superpowers/plans/2026-09-08-stage2-tasks.md` (ESM, strict TS, тесты рядом с кодом, русские тексты, коммиты с трейлером `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, без remote/push, `.env` не трогать).
- Архивный шаблон не выдаётся планировщиком (уже так: `listDueTemplates` берёт `active = 1`) и не создаёт экземпляры при возврате, если он разовый.
- Удалить можно только шаблон без экземпляров: `task_instances` ссылаются на `task_templates` без каскада.

---

### Task 1: Репозиторий, API, админка

**Files:**
- Modify: `server/db/taskTemplates.ts`, `server/db/tasks.test.ts`
- Modify: `server/api/tasks.ts`, `server/api/tasks.test.ts`
- Modify: `admin/src/api.ts`, `admin/src/pages/TemplatesPage.vue`

**Interfaces:**
- Produces: `deleteTaskTemplate(db, id): 'deleted' | 'has_instances' | 'not_found'` в `server/db/taskTemplates.ts` (внутри транзакции: проверка `select 1 from task_instances where template_id = ? limit 1`, затем `delete from task_templates where id = ?`; связи удаляются каскадом).
- Produces HTTP: `DELETE /api/tasks/templates/:id` → 204; 409 `{ error: 'has_instances' }`; 404 `{ error: 'not_found' }`; 401 без сессии. Существующие `/activate` и `/deactivate` остаются как есть (семантика архива).
- Produces admin: `api.tasks.templates.remove(id)`; в `TemplatesPage.vue` кнопки «В архив» (для активных, любых) / «Вернуть» (для архивных), «Удалить» (всегда видна, при 409 показывает «По заданию уже есть история, отправьте его в архив»), переключатель «Показывать архивные» (по умолчанию выключен: список запрашивается через `list(false)`, при включении `list(true)`), колонка «Статус»: «Активно» / «В архиве» (для разовых активных — «Разовое»).

- [ ] **Step 1: Тест репозитория** (в `describe('task templates')` файла `server/db/tasks.test.ts`)

```ts
  it('deletes a template without instances, refuses one with history', () => {
    const t = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    const withHistory = createTaskTemplate(db, { ...baseInput, position_ids: [seed.positions.barista.id] }, null)
    createInstance(db, { template_id: withHistory.id, employee_id: seed.employees.ivan.id, slot_at: NOW, issued_at: NOW, due_at: NOW, status: 'pending' })
    expect(deleteTaskTemplate(db, withHistory.id)).toBe('has_instances')
    expect(deleteTaskTemplate(db, t.id)).toBe('deleted')
    expect(getTaskTemplate(db, t.id)).toBeNull()
    expect(db.prepare('select count(*) c from task_template_positions where template_id = ?').get(t.id)).toEqual({ c: 0 })
    expect(deleteTaskTemplate(db, 999)).toBe('not_found')
  })
```

Run: `npx vitest run server/db/tasks.test.ts` → FAIL (нет `deleteTaskTemplate`).

- [ ] **Step 2: Реализация в `server/db/taskTemplates.ts`**

```ts
export function deleteTaskTemplate(db: Db, id: number): 'deleted' | 'has_instances' | 'not_found' {
  return db.transaction(() => {
    const inUse = db.prepare('select 1 from task_instances where template_id = ? limit 1').get(id)
    if (inUse) return 'has_instances' as const
    const info = db.prepare('delete from task_templates where id = ?').run(id)
    return info.changes === 0 ? ('not_found' as const) : ('deleted' as const)
  })()
}
```

Run: `npx vitest run server/db/tasks.test.ts` → все passed.

- [ ] **Step 3: Тест API** (в `describe('task templates api')` файла `server/api/tasks.test.ts`)

```ts
  it('deletes only templates without history', async () => {
    const { app, seed, h } = await setup()
    const empty = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    const issued = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: { ...weeklyBody(seed), schedule: null } })
    const del = await app.inject({ method: 'DELETE', url: `/api/tasks/templates/${empty.json().template.id}`, headers: h })
    expect(del.statusCode).toBe(204)
    const refused = await app.inject({ method: 'DELETE', url: `/api/tasks/templates/${issued.json().template.id}`, headers: h })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ error: 'has_instances' })
    expect((await app.inject({ method: 'DELETE', url: '/api/tasks/templates/999', headers: h })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/tasks/templates/1' })).statusCode).toBe(401)
    const list = await app.inject({ method: 'GET', url: '/api/tasks/templates?includeInactive=1', headers: h })
    expect(list.json().map((t: { id: number }) => t.id)).toEqual([issued.json().template.id])
  })
```

Run: `npx vitest run server/api/tasks.test.ts` → FAIL (404 вместо 204).

- [ ] **Step 4: Роут в `server/api/tasks.ts`**

```ts
  app.delete('/api/tasks/templates/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params)
    const result = deleteTaskTemplate(db, id)
    if (result === 'has_instances') return reply.code(409).send({ error: 'has_instances' })
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })
```
(импорт `deleteTaskTemplate`). Run: `npx vitest run server/api/tasks.test.ts` → все passed.

- [ ] **Step 5: Админка**

`admin/src/api.ts`, в `api.tasks.templates`: `remove: (id: number) => request<void>('DELETE', \`/api/tasks/templates/${id}\`)`.

`admin/src/pages/TemplatesPage.vue`:
- `const showArchived = ref(false)`; `load()` вызывает `api.tasks.templates.list(showArchived.value)`; чекбокс «Показывать архивные» с `@change="load"` над таблицей.
- `toggle(t)` остаётся (deactivate/activate), кнопка подписана `t.active ? 'В архив' : 'Вернуть'` и показывается для всех шаблонов, не только с расписанием.
- Новая `remove(t)`: `window.confirm(\`Удалить задание «${t.title}»?\`)` → `api.tasks.templates.remove(t.id)` → `load()`; ошибка через `errorText(err, { has_instances: 'По заданию уже есть история, отправьте его в архив.' })`.
- Колонка «Статус»: `!t.active ? 'В архиве' : t.schedule ? 'Активно' : 'Разовое'`.

Run: `npm run build` → чисто.

- [ ] **Step 6: Всё зелёное, commit**

Run: `npm test && npm run typecheck && npm run build`.

```bash
git add server/db/taskTemplates.ts server/db/tasks.test.ts server/api/tasks.ts server/api/tasks.test.ts admin/src/api.ts admin/src/pages/TemplatesPage.vue
git commit -m "feat: archive any task template and delete templates without history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
