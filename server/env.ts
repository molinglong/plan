/**
 * 本地 env 加载：tsx 直接跑 server/index.ts 时不会自动读 .env。
 * Node 20.12+ 提供 process.loadEnvFile，读不到就算了（生产用真环境变量）。
 */
export function loadEnv() {
  try {
    process.loadEnvFile?.()
  } catch {
    // 没有 .env 文件时忽略
  }
}
