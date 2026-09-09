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
  try {
    ;[employees.value, positions.value] = await Promise.all([
      api.employees.list(includeArchived.value),
      api.positions.list(),
    ])
    if (!form.position_id && positions.value[0]) form.position_id = positions.value[0].id
  } catch (err) {
    error.value = errorText(err)
  }
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
      invalid_reference: 'Выбранная должность не существует.',
    })
  }
}

async function archive(e: Employee) {
  if (!window.confirm(`Отправить ${e.full_name} в архив?`)) return
  error.value = ''
  try {
    await api.employees.archive(e.id)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

async function unarchive(e: Employee) {
  error.value = ''
  try {
    await api.employees.unarchive(e.id)
    await load()
  } catch (err) {
    error.value = errorText(err)
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-semibold">Сотрудники</h1>

    <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

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
          <td class="px-4 py-2"><RouterLink :to="`/employees/${e.id}`" class="underline">{{ e.full_name }}</RouterLink></td>
          <td class="px-4 py-2">{{ e.phone }}</td>
          <td class="px-4 py-2">{{ positionName(e.position_id) }}</td>
          <td class="px-4 py-2">{{ statusLabel[e.status] }}</td>
          <td class="px-4 py-2 text-right space-x-2">
            <button v-if="e.status !== 'archived'" class="btn-secondary" @click="startEdit(e)">Изменить</button>
            <button v-if="e.status !== 'archived'" class="btn-secondary" @click="archive(e)">В архив</button>
            <button v-if="e.status === 'archived'" class="btn-secondary" @click="unarchive(e)">Вернуть</button>
          </td>
        </tr>
        <tr v-if="employees.length === 0">
          <td colspan="5" class="px-4 py-3 text-gray-500">Пока пусто</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
