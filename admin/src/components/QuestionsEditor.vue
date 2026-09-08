<script setup lang="ts">
import type { Question } from '../api'

const props = defineProps<{ modelValue: Question[] }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: Question[]): void }>()

function update(fn: (list: Question[]) => void) {
  const copy = props.modelValue.map((q) => ({ ...q, options: [...q.options] }))
  fn(copy)
  emit('update:modelValue', copy)
}
const add = () => update((l) => l.push({ text: '', options: ['', ''], correct_index: 0 }))
const remove = (i: number) => update((l) => l.splice(i, 1))
const addOption = (i: number) => update((l) => { if (l[i]!.options.length < 5) l[i]!.options.push('') })
const removeOption = (i: number, j: number) =>
  update((l) => {
    const q = l[i]!
    if (q.options.length <= 2) return
    q.options.splice(j, 1)
    if (q.correct_index >= q.options.length) q.correct_index = 0
  })
function setText(i: number, ev: Event) {
  const value = (ev.target as HTMLInputElement).value
  update((l) => (l[i]!.text = value))
}
function setOption(i: number, j: number, ev: Event) {
  const value = (ev.target as HTMLInputElement).value
  update((l) => (l[i]!.options[j] = value))
}
</script>

<template>
  <div class="space-y-3">
    <div v-for="(q, i) in modelValue" :key="i" class="border rounded-lg p-3 space-y-2">
      <div class="flex gap-2">
        <input :value="q.text" class="input" placeholder="Текст вопроса" @input="setText(i, $event)" />
        <button type="button" class="btn-secondary" @click="remove(i)">Убрать</button>
      </div>
      <div v-for="(o, j) in q.options" :key="j" class="flex gap-2 items-center">
        <input type="radio" :name="`correct-${i}`" :checked="q.correct_index === j" title="Правильный ответ" @change="update((l) => (l[i]!.correct_index = j))" />
        <input :value="o" class="input" placeholder="Вариант ответа" @input="setOption(i, j, $event)" />
        <button v-if="q.options.length > 2" type="button" class="btn-secondary" @click="removeOption(i, j)">×</button>
      </div>
      <button v-if="q.options.length < 5" type="button" class="btn-secondary" @click="addOption(i)">+ вариант</button>
    </div>
    <button type="button" class="btn-secondary" @click="add">+ вопрос</button>
    <p class="text-xs text-gray-500">Отметьте правильный ответ переключателем слева.</p>
  </div>
</template>
