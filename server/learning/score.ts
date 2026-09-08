import type { Question } from '../db/quizzes.js'

export function scoreAnswers(answers: number[], questions: Question[]): { correct: number; total: number; score: number } {
  const sorted = [...questions].sort((a, b) => a.position - b.position)
  const correct = sorted.filter((qu, i) => answers[i] === qu.correct_index).length
  const total = sorted.length
  return { correct, total, score: total === 0 ? 0 : Math.round((correct / total) * 100) }
}

export const isPassed = (score: number, passScore: number): boolean => score >= passScore
