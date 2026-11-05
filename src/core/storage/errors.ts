/**
 * 存储层错误类型。
 *
 * 这些错误都保留机器可读 code 和可定位路径；调用方不得把完整性错误、
 * schema 不兼容或路径逃逸降级成“重新建一个空库”之类的自动修复。
 */

export type StorageErrorCode =
  | 'CLOSED'
  | 'PATH_UNSAFE'
  | 'DATABASE_CORRUPT'
  | 'SCHEMA_INCOMPATIBLE'
  | 'RECORD_INVALID'
  | 'DUPLICATE_ID'
  | 'TOMBSTONED'
  | 'REFERENCE_MISSING'
  | 'BACKUP_FAILED'
  | 'RESTORE_FAILED'
  | 'IO'

export class StorageError extends Error {
  readonly code: StorageErrorCode
  readonly path?: string

  constructor(code: StorageErrorCode, message: string, options: {
    cause?: unknown
    path?: string
  } = {}) {
    super(message, { cause: options.cause })
    this.name = 'StorageError'
    this.code = code
    this.path = options.path
  }
}

export class StorageIntegrityError extends StorageError {
  constructor(message: string, path: string, cause?: unknown) {
    super('DATABASE_CORRUPT', message, { path, cause })
    this.name = 'StorageIntegrityError'
  }
}

export class SchemaCompatibilityError extends StorageError {
  constructor(message: string, path: string, cause?: unknown) {
    super('SCHEMA_INCOMPATIBLE', message, { path, cause })
    this.name = 'SchemaCompatibilityError'
  }
}

export class StoragePathError extends StorageError {
  constructor(message: string, path?: string) {
    super('PATH_UNSAFE', message, { path })
    this.name = 'StoragePathError'
  }
}
