/*
 * 一条命令起两个进程：vite（前端）+ tsx watch（后端）。
 *
 * 不用 concurrently：它在 Windows 上把第二条命令吞掉，起不来后端（dev 里
 * 只剩 vite，proxy 一直 ECONNREFUSED）。这里直接 spawn，输出加前缀，
 * 任一端退出就带走另一端，避免留下僵尸进程。
 */
import { spawn } from 'node:child_process'

const children = []

function run(name, command) {
  const child = spawn(command, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: process.env,
  })
  children.push(child)

  const tag = name === 'web' ? '\x1b[90m[web]\x1b[0m' : '\x1b[36m[api]\x1b[0m'
  const forward = (stream, target) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) target.write(`${tag} ${line}\n`)
      }
    })
  }
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') return
    console.log(`${tag} 退出（code=${code ?? 'signal ' + signal}），一起停掉`)
    shutdown(code ?? 1)
  })

  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('web', 'vite')
run('api', 'tsx watch server/index.ts')
