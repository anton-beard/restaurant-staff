export const CB = {
  open: (id: number) => `task:open:${id}`,
  done: (id: number) => `task:done:${id}`,
  photo: (id: number) => `task:photo:${id}`,
  claim: (id: number) => `task:claim:${id}`,
  accept: (submissionId: number) => `review:accept:${submissionId}`,
  reject: (submissionId: number) => `review:reject:${submissionId}`,
  courseContinue: (assignmentId: number) => `course:continue:${assignmentId}`,
  courseNext: (assignmentId: number, lesson: number) => `course:next:${assignmentId}:${lesson}`,
  quizStart: (assignmentId: number) => `quiz:start:${assignmentId}`,
  quizAnswer: (attemptId: number, question: number, option: number) => `quiz:answer:${attemptId}:${question}:${option}`,
}

export const CB_RE = {
  open: /^task:open:(\d+)$/,
  done: /^task:done:(\d+)$/,
  photo: /^task:photo:(\d+)$/,
  claim: /^task:claim:(\d+)$/,
  accept: /^review:accept:(\d+)$/,
  reject: /^review:reject:(\d+)$/,
  courseContinue: /^course:continue:(\d+)$/,
  courseNext: /^course:next:(\d+):(\d+)$/,
  quizStart: /^quiz:start:(\d+)$/,
  quizAnswer: /^quiz:answer:(\d+):(\d+):(\d+)$/,
}
