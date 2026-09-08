export const CB = {
  open: (id: number) => `task:open:${id}`,
  done: (id: number) => `task:done:${id}`,
  photo: (id: number) => `task:photo:${id}`,
  claim: (id: number) => `task:claim:${id}`,
  accept: (submissionId: number) => `review:accept:${submissionId}`,
  reject: (submissionId: number) => `review:reject:${submissionId}`,
}

export const CB_RE = {
  open: /^task:open:(\d+)$/,
  done: /^task:done:(\d+)$/,
  photo: /^task:photo:(\d+)$/,
  claim: /^task:claim:(\d+)$/,
  accept: /^review:accept:(\d+)$/,
  reject: /^review:reject:(\d+)$/,
}
