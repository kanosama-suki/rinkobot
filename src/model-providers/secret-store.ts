/**
 * 模型 API key 的本地加密存储。
 *
 * 边界：
 * - 密钥只写入运行时配置目录下的独立文件，不进入 TOML、SQLite、审计或日志；
 * - values 使用 AES-256-GCM 加密，master key 与密文分文件保存并尽力设为
 *   仅当前用户可读写；Windows 上 chmod 的 ACL 效果有限，因此加密本身是
 *   第二道边界，而不是把文件权限当成唯一保护；
 * - 任何错误只说明文件或格式问题，不回显密文或明文。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const STORE_VERSION = 1
const KEY_BYTES = 32
const IV_BYTES = 12
const MAX_SECRET_CHARS = 8_192

interface SecretEntry {
  label: string
  iv: string
  tag: string
  data: string
  createdAt: string
}

interface SecretFile {
  schemaVersion: 1
  entries: Record<string, SecretEntry>
}

export class SecretStoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SecretStoreError'
    this.code = code
  }
}

export class LocalSecretStore {
  readonly directory: string
  private readonly keyPath: string
  private readonly storePath: string

  constructor(configDir: string) {
    this.directory = join(configDir, 'secrets')
    this.keyPath = join(this.directory, 'model-secrets.key')
    this.storePath = join(this.directory, 'model-secrets.json')
  }

  put(value: string, label: string): string {
    const secret = validateSecret(value)
    const normalizedLabel = validateLabel(label, 'secret label')
    const key = this.loadOrCreateKey()
    const id = `secret_${randomUUID().replaceAll('-', '')}`
    const file = this.readStore()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ])
    file.entries[id] = {
      label: normalizedLabel,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
      createdAt: new Date().toISOString(),
    }
    this.writeStore(file)
    return id
  }

  get(ref: string): string {
    const id = validateReference(ref)
    const file = this.readStore()
    const entry = file.entries[id]
    if (entry === undefined) {
      throw new SecretStoreError(
        'secret_not_found',
        `secret reference "${id}" does not exist`,
      )
    }
    let key: Buffer
    try {
      key = this.readKey()
    } catch {
      throw new SecretStoreError(
        'secret_key_unavailable',
        'the local secret key is unavailable',
      )
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(entry.iv, 'base64'),
      )
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      const value = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      return validateSecret(value)
    } catch {
      throw new SecretStoreError(
        'secret_decrypt_failed',
        'the stored model credential could not be decrypted',
      )
    }
  }

  has(ref: string): boolean {
    try {
      const id = validateReference(ref)
      return this.readStore().entries[id] !== undefined
    } catch {
      return false
    }
  }

  describe(ref: string): string | null {
    try {
      const id = validateReference(ref)
      const entry = this.readStore().entries[id]
      return entry?.label ?? null
    } catch {
      return null
    }
  }

  private readStore(): SecretFile {
    if (!existsSync(this.storePath)) {
      return { schemaVersion: STORE_VERSION, entries: {} }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.storePath, 'utf8'))
    } catch {
      throw new SecretStoreError(
        'secret_store_corrupt',
        'the local model secret store is not valid JSON',
      )
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).schemaVersion !== STORE_VERSION ||
      typeof (parsed as Record<string, unknown>).entries !== 'object' ||
      (parsed as Record<string, unknown>).entries === null ||
      Array.isArray((parsed as Record<string, unknown>).entries)
    ) {
      throw new SecretStoreError(
        'secret_store_corrupt',
        'the local model secret store has an unsupported schema',
      )
    }
    const entries = (parsed as { entries: Record<string, unknown> }).entries
    for (const [id, value] of Object.entries(entries)) {
      if (!/^secret_[A-Za-z0-9]{16,80}$/.test(id) || !isEntry(value)) {
        throw new SecretStoreError(
          'secret_store_corrupt',
          'the local model secret store contains an invalid entry',
        )
      }
    }
    return parsed as SecretFile
  }

  private writeStore(file: SecretFile): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    restrictPermissions(this.directory, 0o700)
    const target = `${this.storePath}.${process.pid}.tmp`
    writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w',
    })
    restrictPermissions(target, 0o600)
    replaceFile(target, this.storePath)
    restrictPermissions(this.storePath, 0o600)
  }

  private loadOrCreateKey(): Buffer {
    if (existsSync(this.keyPath)) return this.readKey()
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    restrictPermissions(this.directory, 0o700)
    const target = `${this.keyPath}.${process.pid}.tmp`
    writeFileSync(target, randomBytes(KEY_BYTES), {
      mode: 0o600,
      flag: 'wx',
    })
    restrictPermissions(target, 0o600)
    replaceFile(target, this.keyPath)
    restrictPermissions(this.keyPath, 0o600)
    return this.readKey()
  }

  private readKey(): Buffer {
    if (!existsSync(this.keyPath)) {
      throw new SecretStoreError(
        'secret_key_unavailable',
        'the local model secret key is unavailable',
      )
    }
    const key = readFileSync(this.keyPath)
    if (key.byteLength !== KEY_BYTES) {
      throw new SecretStoreError(
        'secret_key_corrupt',
        'the local model secret key has an invalid length',
      )
    }
    return key
  }
}

function validateSecret(value: string): string {
  if (typeof value !== 'string') {
    throw new SecretStoreError(
      'secret_invalid',
      'the model credential must be a string',
    )
  }
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SECRET_CHARS ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new SecretStoreError(
      'secret_invalid',
      'the model credential is empty, too long, or contains control characters',
    )
  }
  return normalized
}

function validateReference(value: string): string {
  if (!/^secret_[A-Za-z0-9]{16,80}$/.test(value)) {
    throw new SecretStoreError(
      'secret_reference_invalid',
      'the model credential reference is invalid',
    )
  }
  return value
}

function validateLabel(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SecretStoreError(
      'secret_label_invalid',
      `${field} must be a short single-line label`,
    )
  }
  return value.trim()
}

function isEntry(value: unknown): value is SecretEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    typeof entry.label === 'string' &&
    typeof entry.iv === 'string' &&
    typeof entry.tag === 'string' &&
    typeof entry.data === 'string' &&
    typeof entry.createdAt === 'string'
  )
}

function restrictPermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Windows 的 chmod 只覆盖只读位；加密仍保护密文，启动不因 ACL 差异失败。
  }
}

function replaceFile(source: string, target: string): void {
  try {
    renameSync(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      throw error
    }
    rmSync(target, { force: true })
    renameSync(source, target)
  }
}
