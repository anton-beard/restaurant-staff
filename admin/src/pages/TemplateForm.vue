<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, errorText, type Employee, type Position, type Schedule, type TaskTemplateInput } from '../api'
import { DAY_LABELS } from '../lib/schedule'

const props = defineProps<{ id?: string }>()
const router = useRouter()
const editing = computed(() => props.id !== undefined)

const positions = ref<Position[]>([])
const employees = ref<Employee[]>([])
const error = ref('')
const busy = ref(false)

const form = reactive({
  title: '',
  description: '',
  requires_photo: true,
  photo_criteria: '',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position' as 'by_position' | 'by_employees',
  distribution: 'each' as 'each' | 'shared',
  position_ids: [] as number[],
  employee_ids: [] as number[],
  schedule_kind: 'once' as 'once' | 'weekly' | 'interval',
  days: [1, 2, 3, 4, 5, 6, 7] as number[],
  times: ['22:00'] as string[],
  from: '10:00',
  to: '23:00',
  every_minutes: 120,
  deadline_minutes: 60,
})

function toggleDay(d: number) {
  form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]
}

function buildSchedule(): Schedule | null {
  if (form.schedule_kind === 'once') return null
  if (form.schedule_kind === 'weekly') return { kind: 'weekly', days: form.days, times: form.times.filter(Boolean) }
  return { kind: 'interval', days: form.days, from: form.from, to: form.to, every_minutes: Number(form.every_minutes) }
}

function toInput(): TaskTemplateInput {
  return {
    title: form.title,
    description: form.description,
    requires_photo: form.requires_photo,
    photo_criteria: form.requires_photo ? form.photo_criteria : null,
    auto_accept_threshold: Number(form.auto_accept_threshold),
    assignee_mode: form.assignee_mode,
    distribution: form.distribution,
    position_ids: form.position_ids,
    employee_ids: form.employee_ids,
    schedule: buildSchedule(),
    deadline_minutes: Number(form.deadline_minutes),
  }
}

async function load() {
  ;[positions.value, employees.value] = await Promise.all([api.positions.list(), api.employees.list(false)])
  if (!props.id) return
  const t = await api.tasks.templates.get(Number(props.id))
  Object.assign(form, {
    title: t.title, description: t.description, requires_photo: t.requires_photo, photo_criteria: t.photo_criteria ?? '',
    auto_accept_threshold: t.auto_accept_threshold, assignee_mode: t.assignee_mode, distribution: t.distribution,
    position_ids: t.position_ids, employee_ids: t.employee_ids, deadline_minutes: t.deadline_minutes,
    schedule_kind: t.schedule?.kind ?? 'once',
  })
  if (t.schedule) {
    form.days = t.schedule.days
    if (t.schedule.kind === 'weekly') form.times = t.schedule.times
    else Object.assign(form, { from: t.schedule.from, to: t.schedule.to, every_minutes: t.schedule.every_minutes })
  }
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    if (editing.value) {
      await api.tasks.templates.update(Number(props.id), toInput())
      await router.push('/tasks')
      return
    }
    const r = await api.tasks.templates.create(toInput())
    if (r.issued) {
      window.alert(`Выдано: ${r.issued.created}, уведомлено: ${r.issued.notified}`)
      await router.push('/journal')
    } else {
      await router.push('/tasks')
    }
  } catch (err) {
    error.value = errorText(err, { invalid_reference: 'Выбранная должность или сотрудник не существует.' })
  } finally {
    busy.value = false
  }
}

onMounted(() => load().catch((err) => (error.value = errorText(err))))
</script>

<template>
  <form class="space-y-5 max-w-2xl" @submit.prevent="save">
    <h1 class="text-xl font-semibold">{{ editing ? 'Задание' : 'Новое задание' }}</h1>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <label class="block text-sm">Название<input v-model="form.title" class="input mt-1" required maxlength="200" /></label>
      <label class="block text-sm">Описание<textarea v-model="form.description" class="input mt-1" rows="2" /></label>
      <label class="flex items-center gap-2 text-sm"><input v-model="form.requires_photo" type="checkbox" /> Требуется фото</label>
      <template v-if="form.requires_photo">
        <label class="block text-sm">
          Что должно быть на фото (критерии для ИИ)
          <textarea v-model="form.photo_criteria" class="input mt-1" rows="3"
            placeholder="Например: группы кофемашины без остатков кофе, холдеры чистые, поддон пустой и сухой" />
        </label>
        <label class="block text-sm">
          Порог автоприёма, 0–100
          <input v-model.number="form.auto_accept_threshold" type="number" min="0" max="100" class="input mt-1 max-w-32" />
          <span class="block text-xs text-gray-500 mt-1">Оценка ИИ не ниже порога принимается без вас, остальное придёт на проверку.</span>
        </label>
      </template>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Кому</div>
      <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <label class="flex items-center gap-1"><input v-model="form.assignee_mode" type="radio" value="by_position" /> По должностям</label>
        <label class="flex items-center gap-1"><input v-model="form.assignee_mode" type="radio" value="by_employees" /> Поимённо</label>
      </div>
      <div v-if="form.assignee_mode === 'by_position'" class="flex flex-wrap gap-3 text-sm">
        <label v-for="p in positions" :key="p.id" class="flex items-center gap-1">
          <input v-model="form.position_ids" type="checkbox" :value="p.id" /> {{ p.name }}
        </label>
      </div>
      <div v-else class="flex flex-wrap gap-3 text-sm">
        <label v-for="e in employees" :key="e.id" class="flex items-center gap-1">
          <input v-model="form.employee_ids" type="checkbox" :value="e.id" /> {{ e.full_name }}
        </label>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm pt-2">
        <label class="flex items-center gap-1"><input v-model="form.distribution" type="radio" value="each" /> Каждому своя копия</label>
        <label class="flex items-center gap-1"><input v-model="form.distribution" type="radio" value="shared" /> Одно на всех, берёт первый</label>
      </div>
    </section>

    <section class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="text-sm font-medium">Когда</div>
      <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <label class="flex items-center gap-1"><input v-model="form.schedule_kind" type="radio" value="once" /> Разовое, сейчас</label>
        <label class="flex items-center gap-1"><input v-model="form.schedule_kind" type="radio" value="weekly" /> По дням недели</label>
        <label class="flex items-center gap-1"><input v-model="form.schedule_kind" type="radio" value="interval" /> Каждые N часов</label>
      </div>
      <template v-if="form.schedule_kind !== 'once'">
        <div class="flex flex-wrap gap-1">
          <button v-for="(label, i) in DAY_LABELS" :key="i" type="button" class="btn-secondary"
            :class="{ 'bg-gray-900 text-white': form.days.includes(i + 1) }" @click="toggleDay(i + 1)">{{ label }}</button>
        </div>
        <div v-if="form.schedule_kind === 'weekly'" class="space-y-2">
          <div v-for="(_, i) in form.times" :key="i" class="flex gap-2 items-center">
            <input v-model="form.times[i]" type="time" class="input max-w-40" required />
            <button v-if="form.times.length > 1" type="button" class="btn-secondary" @click="form.times.splice(i, 1)">Убрать</button>
          </div>
          <button type="button" class="btn-secondary" @click="form.times.push('12:00')">+ время</button>
        </div>
        <div v-else class="flex flex-wrap gap-3 items-end text-sm">
          <label>С<input v-model="form.from" type="time" class="input mt-1 max-w-40" required /></label>
          <label>До<input v-model="form.to" type="time" class="input mt-1 max-w-40" required /></label>
          <label>Каждые, минут<input v-model.number="form.every_minutes" type="number" min="15" step="15" class="input mt-1 max-w-32" required /></label>
        </div>
      </template>
      <label class="block text-sm">
        Срок выполнения, минут
        <div class="flex flex-wrap gap-2 items-center mt-1">
          <input v-model.number="form.deadline_minutes" type="number" min="5" class="input max-w-32" required />
          <button v-for="m in [60, 240, 480]" :key="m" type="button" class="btn-secondary" @click="form.deadline_minutes = m">{{ m / 60 }} ч</button>
        </div>
      </label>
    </section>

    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    <div class="flex gap-2">
      <button class="btn" :disabled="busy">{{ editing ? 'Сохранить' : form.schedule_kind === 'once' ? 'Выдать сейчас' : 'Создать' }}</button>
      <RouterLink to="/tasks" class="btn-secondary">Отмена</RouterLink>
    </div>
  </form>
</template>
