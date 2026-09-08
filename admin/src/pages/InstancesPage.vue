<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { api, errorText, type Employee, type InstanceRow, type InstanceStatus, type Submission, type TaskTemplate } from '../api'
import { fmtDate, STATUS_LABEL } from '../lib/schedule'

const rows = ref<InstanceRow[]>([])
const employees = ref<Employee[]>([])
const templates = ref<TaskTemplate[]>([])
const error = ref('')
const filters = reactive<{ status: InstanceStatus | ''; employee_id: number | ''; template_id: number | '' }>({ status: '', employee_id: '', template_id: '' })
const selected = ref<{ instance: InstanceRow; submissions: Submission[] } | null>(null)

const DECISION: Record<string, string> = {
  auto_accepted: 'Принято автоматически',
  needs_review: 'Ждёт владельца',
  owner_accepted: 'Принято владельцем',
  owner_rejected: 'Отклонено владельцем',
}

async function load() {
  error.value = ''
  try {
    rows.value = await api.tasks.instances.list({
      status: filters.status || undefined,
      employee_id: filters.employee_id || undefined,
      template_id: filters.template_id || undefined,
    })
  } catch (err) {
    error.value = errorText(err)
  }
}

async function open(row: InstanceRow) {
  try {
    selected.value = await api.tasks.instances.get(row.id)
  } catch (err) {
    error.value = errorText(err)
  }
}

onMounted(async () => {
  try {
    ;[employees.value, templates.value] = await Promise.all([api.employees.list(true), api.tasks.templates.list(true)])
  } catch (err) {
    error.value = errorText(err)
  }
  await load()
})
watch(filters, load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Журнал заданий</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

    <div class="flex flex-wrap gap-2">
      <select v-model="filters.status" class="input max-w-48">
        <option value="">Все статусы</option>
        <option v-for="(label, key) in STATUS_LABEL" :key="key" :value="key">{{ label }}</option>
      </select>
      <select v-model="filters.employee_id" class="input max-w-56">
        <option value="">Все сотрудники</option>
        <option v-for="e in employees" :key="e.id" :value="e.id">{{ e.full_name }}</option>
      </select>
      <select v-model="filters.template_id" class="input max-w-64">
        <option value="">Все задания</option>
        <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.title }}</option>
      </select>
    </div>

    <table class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500">
        <tr>
          <th class="px-4 py-2">Задание</th>
          <th class="px-4 py-2">Сотрудник</th>
          <th class="px-4 py-2">Выдано</th>
          <th class="px-4 py-2">Срок</th>
          <th class="px-4 py-2">Статус</th>
          <th class="px-4 py-2">ИИ</th>
        </tr>
      </thead>
      <tbody class="divide-y">
        <tr v-for="r in rows" :key="r.id" class="cursor-pointer hover:bg-gray-50" :class="{ 'text-red-700': r.status === 'overdue' }" @click="open(r)">
          <td class="px-4 py-2">{{ r.title }}</td>
          <td class="px-4 py-2">{{ r.employee_name ?? '—' }}</td>
          <td class="px-4 py-2">{{ fmtDate(r.issued_at) }}</td>
          <td class="px-4 py-2">{{ fmtDate(r.due_at) }}</td>
          <td class="px-4 py-2">{{ STATUS_LABEL[r.status] }}</td>
          <td class="px-4 py-2">{{ r.last_score ?? '—' }}</td>
        </tr>
        <tr v-if="rows.length === 0"><td colspan="6" class="px-4 py-3 text-gray-500">Ничего не найдено</td></tr>
      </tbody>
    </table>

    <section v-if="selected" class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="flex items-center">
        <h2 class="font-semibold">{{ selected.instance.title }} — {{ selected.instance.employee_name ?? 'не взято' }}</h2>
        <button class="ml-auto btn-secondary" @click="selected = null">Закрыть</button>
      </div>
      <p class="text-sm text-gray-600">
        Статус: {{ STATUS_LABEL[selected.instance.status] }}, срок {{ fmtDate(selected.instance.due_at) }},
        выполнено {{ fmtDate(selected.instance.completed_at) }}
      </p>
      <p v-if="selected.submissions.length === 0" class="text-sm text-gray-500">Сдач пока нет</p>
      <div v-for="s in selected.submissions" :key="s.id" class="border rounded-lg p-3 space-y-2 text-sm">
        <div>{{ fmtDate(s.created_at) }} · {{ s.decision ? DECISION[s.decision] : 'Проверяется' }}</div>
        <div v-if="s.ai_status === 'done'">ИИ: {{ s.ai_score }} из 100. {{ s.ai_verdict }}<span v-if="s.ai_issues.length"> Замечания: {{ s.ai_issues.join('; ') }}</span></div>
        <div v-else-if="s.ai_status === 'failed'" class="text-amber-700">ИИ недоступен</div>
        <div v-if="s.owner_comment">Комментарий владельца: {{ s.owner_comment }}</div>
        <div class="flex gap-2 flex-wrap">
          <template v-for="p in s.photos" :key="p.id">
            <a v-if="!p.deleted_at" :href="`/api/uploads/${p.path}`" target="_blank"><img :src="`/api/uploads/${p.path}`" class="h-32 rounded" /></a>
            <span v-else class="text-gray-400">фото удалено</span>
          </template>
        </div>
      </div>
    </section>
  </div>
</template>
