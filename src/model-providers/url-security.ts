/**
 * 第三方 OpenAI-compatible 端点的网络前置检查。
 *
 * 配置加载器负责静态 URL 形状校验；这里在每次连接前解析主机名，阻止
 * 未显式允许的私网、回环、链路本地和云元数据地址。真正请求使用
 * redirect: error，避免 3xx 把已授权 URL 变成任意内网探测。
 */

import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const PRIVATE_ADDRESSES = new BlockList()
PRIVATE_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('192.0.0.0', 24, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('192.0.2.0', 24, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('198.51.100.0', 24, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('203.0.113.0', 24, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4')
PRIVATE_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4')
PRIVATE_ADDRESSES.addAddress('::', 'ipv6')
PRIVATE_ADDRESSES.addAddress('::1', 'ipv6')
PRIVATE_ADDRESSES.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')
PRIVATE_ADDRESSES.addSubnet('ff00::', 8, 'ipv6')
PRIVATE_ADDRESSES.addSubnet('2001:db8::', 32, 'ipv6')

export class ModelEndpointError extends Error {
  readonly code = 'model_endpoint_rejected'

  constructor(message: string) {
    super(message)
    this.name = 'ModelEndpointError'
  }
}

export interface EndpointPreflightOptions {
  allowPrivateNetwork: boolean
  lookupHost?: (
    hostname: string,
  ) => Promise<readonly { address: string; family: number }[]>
}

export function createEndpointPreflight(
  baseUrl: string,
  options: EndpointPreflightOptions,
): () => Promise<void> {
  return async () => {
    if (options.allowPrivateNetwork) return
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new ModelEndpointError('model endpoint is not a valid URL')
    }
    const hostname = normalizeHostname(url.hostname)
    if (isForbiddenHostname(hostname)) {
      throw new ModelEndpointError(
        'model endpoint resolves to a private or local address',
      )
    }

    let addresses: readonly { address: string; family: number }[]
    try {
      addresses = isIP(hostname) === 0
        ? await (options.lookupHost ?? defaultLookup)(hostname)
        : [{ address: hostname, family: isIP(hostname) }]
    } catch {
      throw new ModelEndpointError(
        'model endpoint hostname could not be resolved',
      )
    }
    if (addresses.length === 0) {
      throw new ModelEndpointError(
        'model endpoint hostname returned no addresses',
      )
    }
    if (addresses.some(item => isPrivateAddress(item.address))) {
      throw new ModelEndpointError(
        'model endpoint resolves to a private or local address',
      )
    }
  }
}

async function defaultLookup(
  hostname: string,
): Promise<readonly { address: string; family: number }[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase()
}

function isForbiddenHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata'
  )
}

function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  const family = isIP(normalized)
  if (family === 4) return PRIVATE_ADDRESSES.check(normalized, 'ipv4')
  if (family === 6) return PRIVATE_ADDRESSES.check(normalized, 'ipv6')
  return false
}

export const endpointSecurityInternals = {
  isPrivateAddress,
}
