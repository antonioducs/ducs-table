import { describe, expect, it } from 'vitest'
import { claudeEnvironment, codexEnvironment } from '../src/environment.js'

describe('provider environments', () => {
  it('removes ambient provider credentials from Codex', () => {
    const env = codexEnvironment('/private/codex', {
      PATH: '/bin',
      HOME: '/home/test',
      OPENAI_API_KEY: 'secret',
      OPENAI_BASE_URL: 'https://untrusted.example',
      CODEX_ACCESS_TOKEN: 'secret',
    })

    expect(env).toEqual({ PATH: '/bin', HOME: '/home/test', CODEX_HOME: '/private/codex' })
  })

  it('uses an isolated Claude profile and disables ambient features', () => {
    const env = claudeEnvironment('/private/claude', {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_BASE_URL: 'https://untrusted.example',
    })

    expect(env.PATH).toBe('/bin')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/private/claude')
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL')
  })
})
