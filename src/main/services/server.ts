/**
 * 本地行情服务进程管理。
 *
 * 统一后的通信拓扑只有一条数据面：
 *
 *   Electron 窗口 ─┐
 *                  ├─ HTTP /api + WebSocket /ws ─→ tdx_server.py（唯一 Bridge）
 *   浏览器窗口   ─┘
 *
 * 所以主进程不再持有 stdio sidecar、轮询器或 PushHub；它只负责：
 *   · 拉起服务、等端口就绪、退出时关掉；
 *   · 窗口/文件对话框/通知等壳能力（见 native-ipc.ts）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { app } from 'electron'

const STARTUP_TIMEOUT = 30_000
const PORT_LINE = 'PYTHONTDX_PORT='

export interface BackendServer {
  readonly port: number
  readonly baseUrl: string
  stop(): void
}

export interface StartServerOptions {
  /** 0 = 让系统分配；开发模式固定 8765 方便 Vite 代理 */
  preferredPort?: number
  /** 静态页面目录；不传则按打包/开发位置自动找 */
  webDir?: string
}

function serverExecutable(): string | undefined {
  const exe = process.platform === 'win32' ? 'tdx-bridge.exe' : 'tdx-bridge'
  const override = process.env.PYTHONTDX_TDX_SERVER
  // 开发/截图环境即使存在旧的 python/dist 也不要用：它可能是上一版 stdio 构建。
  if (!app.isPackaged && !override) return undefined
  const candidates = [
    override,
    join(process.resourcesPath, 'tdx-bridge', exe),
    join(app.getAppPath(), 'python', 'dist', exe)
  ]
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  )
}

function pythonCommand(): string {
  if (process.env.PYTHONTDX_PYTHON) return process.env.PYTHONTDX_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

function defaultWebDir(): string | undefined {
  const candidates = [join(process.resourcesPath, 'web'), join(app.getAppPath(), 'out', 'web')]
  return candidates.find((dir) => existsSync(join(dir, 'index.html')))
}

function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, port?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(port as number)
    }
    const timer = setTimeout(
      () => finish(new Error('行情服务启动超时（30 秒内没有报告端口）')),
      STARTUP_TIMEOUT
    )
    if (!child.stdout) {
      finish(new Error('行情服务没有 stdout，无法读取端口'))
      return
    }
    const reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => {
      if (!line.startsWith(PORT_LINE)) return
      const port = Number(line.slice(PORT_LINE.length).trim())
      if (Number.isInteger(port) && port > 0) finish(null, port)
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) =>
      finish(
        new Error(`行情服务进程提前退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      )
    )
  })
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT
  let lastError = 'unknown'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/ping`)
      const payload = (await response.json()) as { ok?: boolean }
      if (response.ok && payload.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`行情服务健康检查失败：${lastError}`)
}

async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const response = await fetch(`${baseUrl}/api/ping`, { signal: controller.signal })
    clearTimeout(timer)
    const payload = (await response.json()) as { ok?: boolean }
    return response.ok && payload.ok === true
  } catch {
    return false
  }
}

export async function startBackendServer(options: StartServerOptions = {}): Promise<BackendServer> {
  const preferred = options.preferredPort ?? 0
  // 开发模式热重启/二次启动：同机已有 pythontdx 服务时复用它，
  // 不再起第二个后端抢 7709（PRINCIPLES A6）。
  if (preferred > 0) {
    const existing = `http://127.0.0.1:${preferred}`
    if (await probeHealth(existing)) {
      console.log(`[api] 复用已有行情服务：${existing}`)
      return { port: preferred, baseUrl: existing, stop: () => undefined }
    }
  }

  const webDir = options.webDir ?? defaultWebDir()
  const args = [
    '--serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(preferred),
    ...(webDir ? ['--web-dir', webDir] : [])
  ]

  const packaged = serverExecutable()
  const command = packaged ?? pythonCommand()
  const commandArgs = packaged ? args : [join(app.getAppPath(), 'python', 'tdx_server.py'), ...args]
  // 打包后 app.getAppPath() 指向 resources/app.asar（是文件不是目录），
  // 不能拿来当 cwd，否则 spawn 直接 ENOENT。用 exe 所在目录。
  const cwd = app.isPackaged ? dirname(process.execPath) : app.getAppPath()

  console.log(`[api] 启动本地行情服务：${command} ${commandArgs.join(' ')}`)
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Unix 用进程组，退出时可以整组回收；Windows 用 taskkill /T 杀进程树。
    detached: process.platform !== 'win32',
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk.toString().replace(/^(?!\[api\])/gm, '[api] '))
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    // 端口行由 waitForPort 处理；其余 stdout 只进日志，不参与协议。
    if (!chunk.toString().includes(PORT_LINE)) process.stdout.write(chunk)
  })

  let port: number
  try {
    port = await waitForPort(child)
  } catch (error) {
    child.kill()
    throw error
  }

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(baseUrl)
  } catch (error) {
    child.kill()
    throw error
  }

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (!child.pid) return
    if (process.platform === 'win32') {
      // Nuitka onefile 由一个引导进程再拉起真正的服务进程，只 kill 父进程会留下
      // 孤儿服务继续占 7709；taskkill /T 才能把整棵树收掉。
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
        killer.on('error', () => {
          try {
            child.kill()
          } catch {
            // 已经退出
          }
        })
      } catch {
        child.kill()
      }
      return
    }
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退出
      }
    }
  }
  app.once('will-quit', stop)
  console.log(`[api] 行情服务就绪：${baseUrl}（web=${webDir ?? '未托管'}）`)

  return { port, baseUrl, stop }
}
