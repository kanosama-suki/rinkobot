/**
 * 带文件和字段定位的配置错误。
 *
 * 单个字段校验抛 ConfigFieldError；loader 在文件边界把它转成 ConfigIssue，
 * 最后聚合为 ConfigError，让调用方一次看到尽可能多的问题。
 */

export interface ConfigIssue {
  file: string
  field: string
  message: string
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[]

  constructor(issues: ConfigIssue[]) {
    super(formatConfigIssues(issues))
    this.name = 'ConfigError'
    this.issues = issues
  }
}

export class ConfigFieldError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'ConfigFieldError'
    this.field = field
  }
}

export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  // 这是 CLI 和启动脚本展示给用户的稳定格式，不要只输出 error.message。
  const lines = ['Configuration validation failed:']
  for (const issue of issues) {
    lines.push(`- ${issue.file} [${issue.field}]: ${issue.message}`)
  }
  return lines.join('\n')
}
