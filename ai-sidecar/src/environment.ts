const BASE_RUNTIME_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

export function allowlistedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extraNames: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of [...BASE_RUNTIME_ENV, ...extraNames]) {
    const value = source[name]
    if (typeof value === 'string' && value) result[name] = value
  }
  return result
}

export function codexEnvironment(codexHome: string, source?: NodeJS.ProcessEnv): Record<string, string> {
  return { ...allowlistedEnvironment(source), CODEX_HOME: codexHome }
}

export function claudeEnvironment(configDirectory: string, source?: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...allowlistedEnvironment(source, ['CLAUDE_CODE_GIT_BASH_PATH']),
    CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'ducs-table/0.1.0',
  }
}
