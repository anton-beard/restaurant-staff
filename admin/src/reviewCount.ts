import { ref } from 'vue'
import { api } from './api'

export const reviewCount = ref(0)

export async function refreshReviewCount(): Promise<void> {
  try {
    reviewCount.value = (await api.tasks.reviewQueue()).length
  } catch {
    /* счётчик не критичен */
  }
}
