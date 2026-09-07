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
      locked: 'Код запрашивали недавно. Подождите минуту и попробуйте снова.',
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
        <button class="btn w-full" :disabled="busy || code.trim().length !== 6">Войти</button>
        <button type="button" class="text-sm text-gray-500 underline" @click="requestCode">
          Отправить код ещё раз
        </button>
      </form>

      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    </div>
  </div>
</template>
