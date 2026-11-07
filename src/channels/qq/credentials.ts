/**
 * QQ OneBot 凭据解析。
 *
 * 环境变量名和本地 secret 引用都属于运行时配置；真实 token 只在这个
 * 函数返回后存在于内存。错误消息不包含变量值或 secret 内容。
 */

import type { QqChannelConfig } from '../../core/config/index.ts'

export interface LocalSecretReader {
  get(ref: string): string
}

export class QqCredentialError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'QqCredentialError'
    this.code = code
  }
}

export function resolveQqAccessToken(
  config: Pick<QqChannelConfig, 'accessTokenEnv' | 'accessTokenSecret'>,
  secretStore: LocalSecretReader,
): string | null {
  if (
    config.accessTokenEnv !== null &&
    config.accessTokenSecret !== null
  ) {
    throw new QqCredentialError(
      'qq_token_sources_conflict',
      'QQ 渠道同时配置了环境变量和本地密钥来源',
    )
  }

  let token: string | null = null
  if (config.accessTokenEnv !== null) {
    const value = process.env[config.accessTokenEnv]?.trim()
    if (value === undefined || value === '') {
      throw new QqCredentialError(
        'qq_token_env_missing',
        `QQ 环境变量 "${config.accessTokenEnv}" 未设置`,
      )
    }
    token = value
  } else if (config.accessTokenSecret !== null) {
    try {
      token = secretStore.get(config.accessTokenSecret)
    } catch {
      throw new QqCredentialError(
        'qq_token_secret_missing',
        'QQ 本地密钥不可用',
      )
    }
  }

  if (
    token !== null &&
    (token.length > 2_048 || /[\u0000-\u001f\u007f]/.test(token))
  ) {
    throw new QqCredentialError(
      'qq_token_invalid',
      'QQ access token 包含非法字符',
    )
  }
  return token
}
