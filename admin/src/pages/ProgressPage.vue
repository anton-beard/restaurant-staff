<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { api, errorText, type Course, type CourseAssignmentRow, type Employee, type Quiz, type QuizAssignmentRow, type QuizAttempt } from '../api'
import { fmtDate } from '../lib/schedule'

const tab = ref<'courses' | 'quizzes'>('courses')
const courses = ref<Course[]>([])
const quizzes = ref<Quiz[]>([])
const employees = ref<Employee[]>([])
const courseRows = ref<CourseAssignmentRow[]>([])
const quizRows = ref<QuizAssignmentRow[]>([])
const attempts = ref<Record<number, QuizAttempt[]>>({})
const error = ref('')
const filters = reactive({ employee_id: '' as number | '', course_id: '' as number | '', quiz_id: '' as number | '', status: '' })
const COURSE_STATUS: Record<string, string> = { in_progress: 'В процессе', completed: 'Завершён', overdue: 'Просрочен' }
const QUIZ_STATUS: Record<string, string> = { pending: 'Не сдан', passed: 'Сдан', overdue: 'Просрочен' }

async function load() {
  try {
    if (tab.value === 'courses') {
      courseRows.value = await api.learning.assignments.courses({ employee_id: filters.employee_id || undefined, course_id: filters.course_id || undefined, status: filters.status || undefined })
    } else {
      quizRows.value = await api.learning.assignments.quizzes({ employee_id: filters.employee_id || undefined, quiz_id: filters.quiz_id || undefined, status: filters.status || undefined })
    }
    error.value = ''
  } catch (err) {
    error.value = errorText(err)
  }
}
async function toggleAttempts(row: QuizAssignmentRow) {
  if (attempts.value[row.id]) { delete attempts.value[row.id]; return }
  try {
    attempts.value[row.id] = await api.learning.assignments.attempts(row.id)
  } catch (err) {
    error.value = errorText(err)
  }
}
onMounted(async () => {
  try {
    ;[courses.value, quizzes.value, employees.value] = await Promise.all([api.learning.courses.list(true), api.learning.quizzes.list(true), api.employees.list(true)])
  } catch (err) {
    error.value = errorText(err)
    return
  }
  await load()
})
watch(tab, () => { filters.status = ''; void load() })
watch(filters, load, { deep: true })
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Прогресс обучения</h1>
    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'courses' }" @click="tab = 'courses'">Курсы</button>
      <button class="btn-secondary" :class="{ 'bg-gray-900 text-white': tab === 'quizzes' }" @click="tab = 'quizzes'">Тесты</button>
      <select v-model="filters.employee_id" class="input max-w-56"><option value="">Все сотрудники</option><option v-for="e in employees" :key="e.id" :value="e.id">{{ e.full_name }}</option></select>
      <select v-if="tab === 'courses'" v-model="filters.course_id" class="input max-w-64"><option value="">Все курсы</option><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
      <select v-else v-model="filters.quiz_id" class="input max-w-64"><option value="">Все тесты</option><option v-for="q in quizzes" :key="q.id" :value="q.id">{{ q.title }}</option></select>
      <select v-model="filters.status" class="input max-w-56">
        <option value="">Все статусы</option>
        <template v-if="tab === 'courses'">
          <option v-for="(label, key) in COURSE_STATUS" :key="key" :value="key">{{ label }}</option>
        </template>
        <template v-else>
          <option v-for="(label, key) in QUIZ_STATUS" :key="key" :value="key">{{ label }}</option>
        </template>
      </select>
    </div>

    <table v-if="tab === 'courses'" class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Курс</th><th class="px-4 py-2">Сотрудник</th><th class="px-4 py-2">Урок</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th></tr></thead>
      <tbody class="divide-y">
        <tr v-for="r in courseRows" :key="r.id" :class="{ 'text-red-700': r.status === 'overdue' }">
          <td class="px-4 py-2">{{ r.title }}</td><td class="px-4 py-2">{{ r.employee_name }}</td>
          <td class="px-4 py-2">{{ Math.min(r.current_lesson, r.lesson_count) }} из {{ r.lesson_count }}</td>
          <td class="px-4 py-2">{{ fmtDate(r.due_at) }}</td><td class="px-4 py-2">{{ COURSE_STATUS[r.status] }}</td>
        </tr>
        <tr v-if="courseRows.length === 0"><td colspan="5" class="px-4 py-3 text-gray-500">Ничего не найдено</td></tr>
      </tbody>
    </table>

    <table v-else class="w-full bg-white rounded-xl shadow text-sm">
      <thead class="text-left text-gray-500"><tr><th class="px-4 py-2">Тест</th><th class="px-4 py-2">Сотрудник</th><th class="px-4 py-2">Срок</th><th class="px-4 py-2">Статус</th><th class="px-4 py-2"></th></tr></thead>
      <tbody class="divide-y">
        <template v-for="r in quizRows" :key="r.id">
          <tr :class="{ 'text-red-700': r.status === 'overdue' }">
            <td class="px-4 py-2">{{ r.title }}</td><td class="px-4 py-2">{{ r.employee_name }}</td>
            <td class="px-4 py-2">{{ fmtDate(r.due_at) }}</td><td class="px-4 py-2">{{ QUIZ_STATUS[r.status] }}</td>
            <td class="px-4 py-2 text-right"><button class="btn-secondary" @click="toggleAttempts(r)">Попытки</button></td>
          </tr>
          <tr v-if="attempts[r.id]"><td colspan="5" class="px-4 py-2 bg-gray-50">
            <span v-if="attempts[r.id]!.length === 0" class="text-gray-500">Попыток пока нет</span>
            <ul v-else class="space-y-1">
              <li v-for="a in attempts[r.id]" :key="a.id">{{ fmtDate(a.started_at) }}: {{ a.finished_at ? `${a.score} из 100, ${a.passed ? 'сдано' : 'не сдано'}` : `в процессе, вопрос ${a.current_question}` }}</li>
            </ul>
          </td></tr>
        </template>
        <tr v-if="quizRows.length === 0"><td colspan="5" class="px-4 py-3 text-gray-500">Ничего не найдено</td></tr>
      </tbody>
    </table>
  </div>
</template>
