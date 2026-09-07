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
