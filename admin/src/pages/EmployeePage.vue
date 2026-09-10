<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, errorText, type EmployeeCard, type RatingDays } from '../api'
import { fmtDate, STATUS_LABEL } from '../lib/schedule'

const props = defineProps<{ id: string }>()
const card = ref<EmployeeCard | null>(null)
const days = ref<RatingDays>(30)
const tab = ref<'tasks' | 'courses' | 'quizzes'>('tasks')
const error = ref('')
const COURSE_STATUS: Record<string, string> = { in_progress: 'В процессе', completed: 'Завершён', overdue: 'Просрочен' }
const QUIZ_STATUS: Record<string, string> = { pending: 'Не сдан', passed: 'Сдан', overdue: 'Просрочен' }
const EMP_STATUS: Record<string, string> = { invited: 'Приглашён', active: 'Активен', archived: 'В архиве' }

async function load() {
  error.value = ''
  try {
    card.value = await api.stats.employee(Number(props.id), days.value)
  } catch (err) {
    error.value = errorText(err, { not_found: 'Сотрудник не найден.' })
  }
}
onMounted(load)
watch(days, load)
</script>

<template>
  <div class="space-y-4">
    <RouterLink to="/employees" class="text-sm text-gray-500 hover:underline">← Сотрудники</RouterLink>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <template v-if="card">
      <div class="flex items-baseline gap-3 flex-wrap">
        <h1 class="text-xl font-semibold">{{ card.employee.full_name }}</h1>
        <span class="text-gray-500">{{ card.position_name }} · {{ EMP_STATUS[card.employee.status] }} · {{ card.employee.telegram_id ? 'Telegram привязан' : 'Telegram не привязан' }}</span>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span>Период:</span>
        <button v-for="d in [7, 30, 90] as RatingDays[]" :key="d" class="btn-secondary" :class="{ 'bg-gray-900 text-white': days === d }" @click="days = d">{{ d }} дней</button>
      </div>
      <div class="grid gap-4 md:grid-cols-3 text-sm">
        <div class="bg-white rounded-xl shadow p-4"><div class="text-gray-500">Балл</div><div class="text-2xl font-semibold">{{ card.metrics.score ?? 'нет данных' }}</div></div>
        <div class="bg-white rounded-xl shadow p-4"><div class="text-gray-500">Задания в срок</div><div class="text-2xl font-semibold">{{ card.metrics.tasks.onTime }} из {{ card.metrics.tasks.total }}</div><div :class="card.metrics.tasks.overdue ? 'text-red-700' : 'text-gray-500'">Просрочено: {{ card.metrics.tasks.overdue }}, поздно: {{ card.metrics.tasks.late }}</div></div>
        <div class="bg-white rounded-xl shadow p-4"><div class="text-gray-500">Тесты</div><div class="text-2xl font-semibold">{{ card.metrics.quiz.avgScore ?? '—' }}</div><div class="text-gray-500">Сдано {{ card.metrics.quiz.passed }}, провалено {{ card.metrics.quiz.failed }}</div></div>
      </div>

      <div class="flex gap-2">
        <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'tasks' }" @click="tab = 'tasks'">Задания</button>
        <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'courses' }" @click="tab = 'courses'">Курсы</button>
        <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'quizzes' }" @click="tab = 'quizzes'">Тесты</button>
      </div>

      <div v-if="tab === 'tasks'" class="table-wrap"><table class="w-full text-sm">
        <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Задание</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Выполнено</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2">ИИ</th></tr></thead>
        <tbody class="divide-y">
          <tr v-for="t in card.tasks" :key="t.id" :class="{ 'text-red-700': t.status === 'overdue' }">
            <td class="px-4 py-2">{{ t.title }}</td><td class="px-4 py-2">{{ fmtDate(t.due_at) }}</td><td class="px-4 py-2">{{ fmtDate(t.completed_at) }}</td>
            <td class="px-4 py-2">{{ STATUS_LABEL[t.status] }}</td><td class="px-4 py-2">{{ t.last_score ?? '—' }}</td>
          </tr>
          <tr v-if="card.tasks.length === 0"><td colspan="5" class="px-4 py-3 text-gray-500">Заданий за период нет</td></tr>
        </tbody>
      </table></div>

      <div v-else-if="tab === 'courses'" class="table-wrap"><table class="w-full text-sm">
        <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Курс</th><th class="px-4 py-2">Урок</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th></tr></thead>
        <tbody class="divide-y">
          <tr v-for="c in card.courses" :key="c.id" :class="{ 'text-red-700': c.status === 'overdue' }">
            <td class="px-4 py-2">{{ c.title }}</td><td class="px-4 py-2">{{ Math.min(c.current_lesson, c.lesson_count) }} из {{ c.lesson_count }}</td>
            <td class="px-4 py-2">{{ fmtDate(c.due_at) }}</td><td class="px-4 py-2">{{ COURSE_STATUS[c.status] }}</td>
          </tr>
          <tr v-if="card.courses.length === 0"><td colspan="4" class="px-4 py-3 text-gray-500">Курсов нет</td></tr>
        </tbody>
      </table></div>

      <div v-else class="table-wrap"><table class="w-full text-sm">
        <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Тест</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2">Попытки</th></tr></thead>
        <tbody class="divide-y">
          <tr v-for="q in card.quizzes" :key="q.id" :class="{ 'text-red-700': q.status === 'overdue' }">
            <td class="px-4 py-2">{{ q.title }}</td><td class="px-4 py-2">{{ fmtDate(q.due_at) }}</td><td class="px-4 py-2">{{ QUIZ_STATUS[q.status] }}</td>
            <td class="px-4 py-2">
              <span v-if="q.attempts.length === 0" class="text-gray-500">—</span>
              <span v-else>{{ q.attempts.map((a) => (a.finished_at ? `${a.score ?? '—'}${a.passed ? ' ✓' : ''}` : 'идёт')).join(', ') }}</span>
            </td>
          </tr>
          <tr v-if="card.quizzes.length === 0"><td colspan="4" class="px-4 py-3 text-gray-500">Тестов нет</td></tr>
        </tbody>
      </table></div>
    </template>
  </div>
</template>
