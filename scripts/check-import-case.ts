/**
 * 检查相对 import 的路径大小写是否与磁盘上的真实文件名一致。
 *
 * Windows 文件系统通常不区分大小写，错误路径可能在本机通过，
 * 但部署到 Linux 后会失败。脚本逐段比较路径，定位具体拼写差异。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoots = ['src', 'tests', 'scripts']
const sourceExtensions = new Set(['.ts', '.mts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])
const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]+)\1/g

interface ImportReference {
  file: string
  line: number
  specifier: string
}

interface Problem extends ImportReference {
  message: string
}

const files = sourceRoots.flatMap(root => collectFiles(resolve(repoRoot, root)))
const references = files.flatMap(readImports)
const problems = references.flatMap(checkReference)

// 一次输出所有问题，避免修一个路径后再跑一遍才发现下一个。
if (problems.length > 0) {
  for (const problem of problems) {
    const location = `${relative(repoRoot, problem.file)}:${problem.line}`
    console.error(`${location}: ${problem.specifier}: ${problem.message}`)
  }
  process.exitCode = 1
} else {
  console.log(
    `import case check: ok (${files.length} files, ${references.length} relative imports)`,
  )
}

function collectFiles(path: string): string[] {
  let info
  try {
    info = statSync(path)
  } catch {
    // 可选源码目录不存在时视为空集合，而不是让检查脚本自身失败。
    return []
  }
  if (!info.isDirectory()) return []

  const result: string[] = []
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    const childInfo = statSync(child)
    if (childInfo.isDirectory()) {
      result.push(...collectFiles(child))
    } else if (sourceExtensions.has(extensionOf(name))) {
      result.push(child)
    }
  }
  return result
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot)
}

function readImports(file: string): ImportReference[] {
  const text = readFileSync(file, 'utf8')
  const result: ImportReference[] = []
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[2].split(/[?#]/, 1)[0]
    if (specifier === undefined) continue
    result.push({
      file,
      line: lineOf(text, match.index ?? 0),
      specifier,
    })
  }
  return result
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

function checkReference(reference: ImportReference): Problem[] {
  const target = resolve(dirname(reference.file), reference.specifier)
  const targetRelative = relative(repoRoot, target)
  // 只检查仓库内的相对 import；外部依赖交给 Node 模块解析。
  if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
    return []
  }

  const mismatch = findCaseMismatch(targetRelative)
  if (mismatch !== undefined) {
    return [
      {
        ...reference,
        message: `path casing differs from the file system (${mismatch})`,
      },
    ]
  }

  try {
    const info = statSync(target)
    if (!info.isFile()) {
      return [{ ...reference, message: 'target is not a file' }]
    }
  } catch {
    return [{ ...reference, message: 'target does not exist' }]
  }
  return []
}

function findCaseMismatch(targetRelative: string): string | undefined {
  let current = repoRoot
  // 逐段比较，才能报告到底是哪一级目录或文件名的大小写写错了。
  for (const segment of targetRelative.split(sep)) {
    if (segment === '' || segment === '.') continue
    const entries = readdirSync(current)
    if (entries.includes(segment)) {
      current = join(current, segment)
      continue
    }
    const caseInsensitive = entries.find(
      entry => entry.toLowerCase() === segment.toLowerCase(),
    )
    if (caseInsensitive !== undefined) {
      return `wrote "${segment}", actual is "${caseInsensitive}"`
    }
    return undefined
  }
  return undefined
}
