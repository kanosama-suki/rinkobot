/**
 * 数据目录单进程所有权。
 *
 * 真正的互斥句柄是操作系统 IPC：
 * - Windows 使用机器级命名管道；
 * - Linux 使用抽象 Unix 套接字（随进程退出由内核回收）；
 * - 其他平台明确拒绝，不退回只靠 PID 的不可靠判断。
 *
 * `kanobot.lock` 只保存可读元数据，不承担互斥。进程被 SIGKILL 后 IPC
 * 自动释放，下次启动会覆盖旧元数据；PID 是否被复用不会影响所有权。
 * 元数据损坏、来自其他主机或平台不支持时必须 fail-closed，不静默删除。
 */

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer,
  Socket,
  type Server,
} from 'node:net'
import { hostname as osHostname } from 'node:os'
import { join, resolve } from 'node:path'

export const RUNTIME_LOCK_FILE = 'kanobot.lock'
const RUNTIME_LOCK_SCHEMA_VERSION = 1
const MAX_CONTROL_LINE_BYTES = 2_048
const CONTROL_TIMEOUT_MS = 3_000

export type RuntimeLockErrorCode =
  | 'LOCK_HELD'
  | 'LOCK_INVALID'
  | 'LOCK_FOREIGN_HOST'
  | 'LOCK_UNSUPPORTED_PLATFORM'
  | 'LOCK_NOT_HELD'
  | 'LOCK_RELEASE_FAILED'
  | 'CONTROL_UNAVAILABLE'
  | 'CONTROL_FAILED'

export class RuntimeLockError extends Error {
  readonly code: RuntimeLockErrorCode
  readonly path?: string

  constructor(
    code: RuntimeLockErrorCode,
    message: string,
    options: { cause?: unknown; path?: string } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'RuntimeLockError'
    this.code = code
    this.path = options.path
  }
}

export interface RuntimeLockMetadata {
  schemaVersion: 1
  pid: number
  startedAt: string
  acquiredAt: string
  hostname: string
  ownerToken: string
  version: string
}

export interface RuntimeLockOptions {
  version: string
  startedAt?: Date
  acquiredAt?: Date
  hostname?: string
}

export interface RuntimeControlHandler {
  (
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>
}

interface RuntimeControlState {
  handler: RuntimeControlHandler | undefined
  ownerToken: string | null
  version: string
}

export class RuntimeLock {
  readonly metadata: RuntimeLockMetadata
  readonly path: string

  private readonly server: Server
  private readonly endpoint: string
  private readonly connections: Set<Socket>
  private readonly controlState: RuntimeControlState
  private released = false

  constructor(
    metadata: RuntimeLockMetadata,
    path: string,
    server: Server,
    endpoint: string,
    connections: Set<Socket>,
    controlState: RuntimeControlState,
  ) {
    this.metadata = metadata
    this.path = path
    this.server = server
    this.endpoint = endpoint
    this.connections = connections
    this.controlState = controlState
  }

  setControlHandler(handler: RuntimeControlHandler): void {
    if (this.released) {
      throw new RuntimeLockError(
        'CONTROL_UNAVAILABLE',
        'runtime lock has already been released',
        { path: this.path },
      )
    }
    this.controlState.handler = handler
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    let firstError: unknown

    try {
      const current = readRuntimeLockFile(this.path)
      if (
        current !== null &&
        current.ownerToken === this.metadata.ownerToken
      ) {
        rmSync(this.path, { force: true })
      }
    } catch (error) {
      firstError = error
    }

    for (const connection of this.connections) {
      connection.destroy()
    }
    this.connections.clear()
    try {
      await closeServer(this.server)
    } catch (error) {
      firstError ??= error
    }

    if (firstError !== undefined) {
      throw new RuntimeLockError(
        'LOCK_RELEASE_FAILED',
        `runtime lock release failed: ${errorMessage(firstError)}`,
        { cause: firstError, path: this.path },
      )
    }
  }

  /**
   * 仅供同进程测试或诊断读取；外部命令通过 queryRuntimeControl 访问。
   */
  controlEndpoint(): string {
    return this.endpoint
  }
}

/**
 * 获取数据目录独占所有权。
 *
 * 调用方必须在打开主库、启动 scheduler 和启动 QQ 之前调用，并在关闭
 * 数据库之后释放。失败会给出可执行的人类可读原因，不尝试自动删除
 * 无法解释的锁文件。
 */
export async function acquireRuntimeLock(
  dataDir: string,
  options: RuntimeLockOptions,
): Promise<RuntimeLock> {
  if (typeof options.version !== 'string' || options.version.trim() === '') {
    throw new RuntimeLockError('LOCK_INVALID', 'runtime lock version is required')
  }
  const root = canonicalDataDir(dataDir, true)
  const lockPath = join(root, RUNTIME_LOCK_FILE)
  const endpoint = lockEndpoint(root)
  const connections = new Set<Socket>()
  const controlState: RuntimeControlState = {
    handler: undefined,
    ownerToken: null,
    version: options.version,
  }
  const server = createServer(socket => {
    connections.add(socket)
    socket.setEncoding('utf8')
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy())
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_LINE_BYTES) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = ''
      void respondToControlLine(line, socket, controlState).catch(() => {
        socket.destroy()
      })
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => connections.delete(socket))
  })

  try {
    await listenOnEndpoint(server, endpoint)
  } catch (error) {
    await closeServer(server).catch(() => {})
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const owner = tryReadRuntimeLock(lockPath)
      const ownerText = owner === null
        ? '锁元数据不可读'
        : `pid=${owner.pid} version=${owner.version} startedAt=${owner.startedAt}`
      throw new RuntimeLockError(
        'LOCK_HELD',
        `数据目录已被另一个 Rinkobot 实例占用（${ownerText}）；` +
          '请先停止该实例，或确认它已退出后再启动。',
        { cause: error, path: lockPath },
      )
    }
    throw new RuntimeLockError(
      'LOCK_INVALID',
      `cannot acquire runtime lock: ${errorMessage(error)}`,
      { cause: error, path: lockPath },
    )
  }

  try {
    const existing = readRuntimeLockFile(lockPath)
    const host = options.hostname ?? osHostname()
    if (existing !== null && existing.hostname !== host) {
      throw new RuntimeLockError(
        'LOCK_FOREIGN_HOST',
        `锁属于其他主机 ${existing.hostname}；共享数据目录不能跨主机同时运行。`,
        { path: lockPath },
      )
    }

    const acquiredAt = options.acquiredAt ?? new Date()
    if (Number.isNaN(acquiredAt.getTime())) {
      throw new RuntimeLockError(
        'LOCK_INVALID',
        'runtime lock acquisition time is invalid',
        { path: lockPath },
      )
    }
    const startedAt = options.startedAt ??
      new Date(Date.now() - process.uptime() * 1_000)
    if (Number.isNaN(startedAt.getTime())) {
      throw new RuntimeLockError(
        'LOCK_INVALID',
        'runtime process start time is invalid',
        { path: lockPath },
      )
    }

    const metadata: RuntimeLockMetadata = {
      schemaVersion: RUNTIME_LOCK_SCHEMA_VERSION,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      acquiredAt: acquiredAt.toISOString(),
      hostname: host,
      ownerToken: randomBytes(32).toString('hex'),
      version: options.version,
    }
    controlState.ownerToken = metadata.ownerToken
    writeRuntimeLockFile(lockPath, metadata)
    return new RuntimeLock(
      metadata,
      lockPath,
      server,
      endpoint,
      connections,
      controlState,
    )
  } catch (error) {
    for (const connection of connections) connection.destroy()
    connections.clear()
    await closeServer(server).catch(() => {})
    throw error
  }
}

export function runtimeLockPath(dataDir: string): string {
  const requested = resolve(dataDir)
  try {
    return join(realpathSync.native(requested), RUNTIME_LOCK_FILE)
  } catch {
    return join(requested, RUNTIME_LOCK_FILE)
  }
}

/**
 * 严格读取锁元数据。文件存在但内容损坏时抛 LOCK_INVALID，绝不把损坏
 * 的锁当成“没有锁”。
 */
export function readRuntimeLock(dataDir: string): RuntimeLockMetadata | null {
  const path = runtimeLockPath(dataDir)
  return readRuntimeLockFile(path)
}

/**
 * 向运行中的实例发送本地控制请求。
 *
 * 仅用于同机、同用户的运维命令（例如在 systemd 下把一次性登录链接
 * 打印到操作员终端而不是 journal）。请求必须携带锁文件中的 owner token。
 */
export async function queryRuntimeControl(
  dataDir: string,
  request: Record<string, unknown>,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const root = canonicalDataDir(dataDir, false)
  const lock = readRuntimeLockFile(join(root, RUNTIME_LOCK_FILE))
  if (lock === null) {
    throw new RuntimeLockError(
      'LOCK_NOT_HELD',
      '没有找到运行中的 Rinkobot 实例锁',
      { path: join(root, RUNTIME_LOCK_FILE) },
    )
  }
  if (lock.hostname !== osHostname()) {
    throw new RuntimeLockError(
      'LOCK_FOREIGN_HOST',
      `锁属于其他主机 ${lock.hostname}`,
      { path: join(root, RUNTIME_LOCK_FILE) },
    )
  }

  const response = await sendControlRequest(
    lockEndpoint(root),
    { ...request, ownerToken: lock.ownerToken },
    timeoutMs,
  )
  if (response.ok !== true) {
    throw new RuntimeLockError(
      'CONTROL_FAILED',
      typeof response.error === 'string'
        ? response.error
        : 'Rinkobot 实例拒绝了控制请求',
    )
  }
  return response
}

function writeRuntimeLockFile(
  path: string,
  metadata: RuntimeLockMetadata,
): void {
  const temporary = `${path}.${metadata.ownerToken}.tmp`
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    rmSync(path, { force: true })
    renameSync(temporary, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows 的 mode 语义有限；文件仍位于仅服务用户可访问的数据目录。
    }
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new RuntimeLockError(
      'LOCK_INVALID',
      `cannot write runtime lock file: ${errorMessage(error)}`,
      { cause: error, path },
    )
  }
}

function readRuntimeLockFile(path: string): RuntimeLockMetadata | null {
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new RuntimeLockError(
      'LOCK_INVALID',
      `锁文件 ${path} 无法解析；请确认没有运行中的实例后人工处理。`,
      { cause: error, path },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidLockFile(path, 'expected a JSON object')
  }
  const value = parsed as Record<string, unknown>
  if (value.schemaVersion !== RUNTIME_LOCK_SCHEMA_VERSION) {
    throw invalidLockFile(
      path,
      `unsupported lock schema ${String(value.schemaVersion)}`,
    )
  }
  if (
    !Number.isInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.startedAt !== 'string' ||
    Number.isNaN(Date.parse(value.startedAt)) ||
    typeof value.acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(value.acquiredAt)) ||
    typeof value.hostname !== 'string' ||
    value.hostname === '' ||
    typeof value.ownerToken !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.ownerToken) ||
    typeof value.version !== 'string' ||
    value.version === ''
  ) {
    throw invalidLockFile(path, 'required metadata is missing or invalid')
  }
  return value as unknown as RuntimeLockMetadata
}

function tryReadRuntimeLock(path: string): RuntimeLockMetadata | null {
  try {
    return readRuntimeLockFile(path)
  } catch {
    return null
  }
}

function invalidLockFile(path: string, reason: string): RuntimeLockError {
  return new RuntimeLockError(
    'LOCK_INVALID',
    `锁文件 ${path} 无效（${reason}）；为保护活进程不会自动删除，请人工检查。`,
    { path },
  )
}

function canonicalDataDir(dataDir: string, create: boolean): string {
  const requested = resolve(dataDir)
  if (create) {
    mkdirSync(requested, { recursive: true, mode: 0o700 })
  }
  try {
    return realpathSync.native(requested)
  } catch (error) {
    throw new RuntimeLockError(
      'LOCK_INVALID',
      `data directory is not accessible: ${errorMessage(error)}`,
      { cause: error, path: requested },
    )
  }
}

function lockEndpoint(canonicalRoot: string): string {
  const hash = createHash('sha256')
    .update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot)
    .digest('hex')
    .slice(0, 32)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\kanobot-lock-${hash}`
  }
  if (process.platform === 'linux') {
    return `\0kanobot-lock-${hash}`
  }
  throw new RuntimeLockError(
    'LOCK_UNSUPPORTED_PLATFORM',
    `runtime lock is not implemented for platform ${process.platform}`,
  )
}

async function listenOnEndpoint(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(endpoint)
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}

async function respondToControlLine(
  line: string,
  socket: Socket,
  controlState: RuntimeControlState,
): Promise<void> {
  let request: Record<string, unknown>
  try {
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request must be a JSON object')
    }
    request = parsed as Record<string, unknown>
  } catch {
    await writeControlResponse(socket, { ok: false, error: '控制请求格式无效' })
    return
  }

  const token = request.ownerToken
  if (
    typeof token !== 'string' ||
    !safeTokenEqual(token, controlState.ownerToken)
  ) {
    await writeControlResponse(socket, { ok: false, error: '控制请求未授权' })
    return
  }

  const handler = controlState.handler
  if (handler === undefined) {
    await writeControlResponse(socket, {
      ok: false,
      error: '实例尚未开放控制请求',
    })
    return
  }

  const payload = { ...request }
  delete payload.ownerToken
  try {
    const result = await handler(payload)
    await writeControlResponse(socket, { ok: true, ...result })
  } catch {
    await writeControlResponse(socket, {
      ok: false,
      error: `控制请求失败（version ${controlState.version}）`,
    })
  }
}

function safeTokenEqual(candidate: string, expected: string | null): boolean {
  if (expected === null || candidate.length !== 64 || expected.length !== 64) {
    return false
  }
  const left = Buffer.from(candidate, 'hex')
  const right = Buffer.from(expected, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function writeControlResponse(
  socket: Socket,
  payload: Record<string, unknown>,
): Promise<void> {
  if (socket.destroyed || socket.writableEnded) return
  const body = `${JSON.stringify(payload)}\n`
  await new Promise<void>(resolveWrite => {
    socket.end(body, () => resolveWrite())
  })
}

async function sendControlRequest(
  endpoint: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
    const socket = new Socket()
    let buffer = ''
    let settled = false
    const finish = (error?: unknown, response?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) rejectRequest(error)
      else resolveRequest(response ?? {})
    }

    socket.setTimeout(timeoutMs, () => {
      finish(new RuntimeLockError(
        'CONTROL_FAILED',
        'Rinkobot 实例未在超时内响应控制请求',
      ))
    })
    socket.setEncoding('utf8')
    socket.on('error', error => finish(error))
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CONTROL_LINE_BYTES) {
        finish(new RuntimeLockError('CONTROL_FAILED', '控制响应过大'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as unknown
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error('response must be a JSON object')
        }
        finish(undefined, parsed as Record<string, unknown>)
      } catch (error) {
        finish(error)
      }
    })
    socket.connect(endpoint, () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
