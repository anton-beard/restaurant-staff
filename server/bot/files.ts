export function telegramDownloader(token: string): (filePath: string) => Promise<Buffer> {
  return async (filePath) => {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}
