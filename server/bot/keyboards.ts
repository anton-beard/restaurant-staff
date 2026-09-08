import { InlineKeyboard, Keyboard } from 'grammy'
import { CB } from './callbacks.js'

export const BTN = {
  tasks: 'Мои задания',
  learning: 'Обучение',
  quizzes: 'Тесты',
  rating: 'Мой рейтинг',
  summary: 'Сводка',
  photosDone: 'Готово',
  cancel: 'Отмена',
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

export const openTaskKeyboard = (id: number) => new InlineKeyboard().text('Открыть', CB.open(id))
export const claimKeyboard = (id: number) => new InlineKeyboard().text('Беру', CB.claim(id))
export const taskCardKeyboard = (id: number, requiresPhoto: boolean) =>
  requiresPhoto
    ? new InlineKeyboard().text('Отправить фото', CB.photo(id))
    : new InlineKeyboard().text('Выполнено', CB.done(id))
export const photoCollectKeyboard = () => new Keyboard().text(BTN.photosDone).text(BTN.cancel).resized()
export const cancelKeyboard = () => new Keyboard().text(BTN.cancel).resized()
export const reviewKeyboard = (submissionId: number) =>
  new InlineKeyboard().text('Принять', CB.accept(submissionId)).text('Отклонить', CB.reject(submissionId))

export const continueCourseKeyboard = (assignmentId: number) => new InlineKeyboard().text('Продолжить', CB.courseContinue(assignmentId))
export const nextLessonKeyboard = (assignmentId: number, lesson: number) => new InlineKeyboard().text('Прочитал, дальше', CB.courseNext(assignmentId, lesson))
export const startQuizKeyboard = (assignmentId: number, label = 'Начать') => new InlineKeyboard().text(label, CB.quizStart(assignmentId))
export function answersKeyboard(attemptId: number, question: number, options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  options.forEach((o, i) => kb.text(o, CB.quizAnswer(attemptId, question, i)).row())
  return kb
}
