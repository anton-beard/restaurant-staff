import type { Db } from '../db/connect.js'
import { createCourse, replaceLessons, type Course, type CourseInput } from '../db/courses.js'
import { createQuiz, replaceQuestions, type Quiz, type QuizInput } from '../db/quizzes.js'
import { nextRun } from '../tasks/schedule.js'

export function seedCourse(db: Db, positionIds: number[], over: Partial<CourseInput> = {}): { course: Course; quiz: Quiz } {
  const created = createCourse(db, {
    title: 'Эспрессо по стандарту', description: 'Базовый курс бариста', due_days: 7, pass_score: 80, position_ids: positionIds, ...over,
  })
  replaceLessons(db, created.id, [
    { title: 'Помол и дозировка', body: 'Помол под эспрессо: 18 г на двойной холдер.', media: [] },
    { title: 'Экстракция', body: 'Экстракция 25–30 секунд.', media: [{ kind: 'image', path: 'lessons/test.jpg' }, { kind: 'video', url: 'https://youtu.be/x' }] },
    { title: 'Молоко', body: 'Молоко до 60–65 °C.', media: [] },
  ])
  const quiz = createQuiz(db, { title: 'Итоговый тест: Эспрессо', course_id: created.id, pass_score: 80, schedule: null, deadline_minutes: null, position_ids: [] }, null)
  replaceQuestions(db, quiz.id, [
    { text: 'Сколько секунд длится экстракция?', options: ['10–15', '25–30', '50–60'], correct_index: 1 },
    { text: 'Температура молока для капучино?', options: ['60–65 °C', '80–90 °C'], correct_index: 0 },
  ])
  const course = { ...created, lesson_count: 3 }
  return { course, quiz: { ...quiz, question_count: 2 } }
}

export function seedQuiz(db: Db, positionIds: number[], over: Partial<QuizInput> = {}): Quiz {
  const input: QuizInput = {
    title: 'Меню недели', course_id: null, pass_score: 80,
    schedule: { kind: 'weekly', days: [1], times: ['10:00'] }, deadline_minutes: 480, position_ids: positionIds, ...over,
  }
  const quiz = createQuiz(db, input, input.schedule ? nextRun(input.schedule, new Date('2026-09-07T00:00:00.000Z'), 'Europe/Moscow').toISOString() : null)
  replaceQuestions(db, quiz.id, [
    { text: 'Что в сезонном меню?', options: ['Тыквенный латте', 'Окрошка'], correct_index: 0 },
    { text: 'Цена капучино?', options: ['250', '300', '350'], correct_index: 1 },
  ])
  return { ...quiz, question_count: 2 }
}
