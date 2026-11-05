/**
 * 与宿主无关的基础字段校验函数。
 *
 * 每个函数失败时抛出 ConfigFieldError，并保留 TOML 字段路径。
 * 文件级错误转换由 loader 负责，这里不读取磁盘或环境变量。
 */

import { ConfigFieldError } from './errors.ts'

export type TomlTable = Record<string, unknown>

const QUIET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function isTable(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asTable(value: unknown, field: string): TomlTable {
  if (!isTable(value)) {
    fail(field, 'expected a TOML table')
  }
  return value
}

export function knownKeys(table: TomlTable, allowed: readonly string[], field: string): void {
  // 拒绝未知字段，避免拼写错误或旧字段被静默忽略。
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) {
      fail(joinField(field, key), 'unknown field')
    }
  }
}

export function requiredTable(
  parent: TomlTable,
  key: string,
  field: string,
): TomlTable {
  if (!(key in parent)) {
    fail(field, 'required table is missing')
  }
  return asTable(parent[key], field)
}

export function requiredString(
  parent: TomlTable,
  key: string,
  field: string,
  minLength = 1,
  maxLength = 512,
): string {
  const value = parent[key]
  if (typeof value !== 'string') {
    fail(field, 'expected a string')
  }
  if (value.length < minLength || value.length > maxLength) {
    fail(field, `expected length ${minLength}..${maxLength}, got ${value.length}`)
  }
  return value
}

export function requiredInteger(
  parent: TomlTable,
  key: string,
  field: string,
  min: number,
  max: number,
): number {
  const value = parent[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(field, 'expected an integer')
  }
  if (value < min || value > max) {
    fail(field, `expected ${min}..${max}, got ${value}`)
  }
  return value
}

export function requiredNumber(
  parent: TomlTable,
  key: string,
  field: string,
  min: number,
  max: number,
): number {
  const value = parent[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, 'expected a finite number')
  }
  if (value < min || value > max) {
    fail(field, `expected ${min}..${max}, got ${value}`)
  }
  return value
}

export function requiredBoolean(
  parent: TomlTable,
  key: string,
  field: string,
): boolean {
  const value = parent[key]
  if (typeof value !== 'boolean') {
    fail(field, 'expected a boolean')
  }
  return value
}

export function requiredStringArray(
  parent: TomlTable,
  key: string,
  field: string,
): string[] {
  const value = parent[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    fail(field, 'expected an array of strings')
  }
  const unique = new Set(value)
  if (unique.size !== value.length) {
    fail(field, 'duplicate entries are not allowed')
  }
  return [...value]
}

export function requireSchemaVersion(table: TomlTable, expected: number): void {
  const version = requiredInteger(table, 'schema_version', 'schema_version', 1, 1_000_000)
  if (version !== expected) {
    fail('schema_version', `unsupported schema version ${version}; expected ${expected}`)
  }
}

export function requireQuietTime(value: string, field: string): void {
  if (!QUIET_TIME.test(value)) {
    fail(field, 'expected HH:MM in 24-hour time')
  }
}

export function requireTimezone(value: string, field: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
  } catch {
    fail(field, `unknown IANA timezone "${value}"`)
  }
}

export function requireSafeRelativePath(value: string, field: string): void {
  // persona_file 等路径必须留在数据目录内，不能指向任意系统文件。
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    fail(field, 'absolute paths are not allowed')
  }
  const segments = value.split(/[\\/]+/)
  if (segments.some(segment => segment === '..')) {
    fail(field, 'parent-directory traversal is not allowed')
  }
}

export function requireSafeFileName(value: string, field: string): void {
  // STOP 文件只能是数据目录下的普通文件名，不能借路径切换到其他位置。
  if (
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(field, 'expected a plain file name without path separators')
  }
}

export function fail(field: string, message: string): never {
  // 统一抛出字段错误，确保 loader 能附加正确的文件名。
  throw new ConfigFieldError(field, message)
}

export function joinField(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key
}
