import { describe, expect, it } from 'vitest'
import manifest from '../package.json' with { type: 'json' }

describe('DSH package contract', () => {
  it('ships one stable bundle layer and a web client entry', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('keeps Better Sidebar optional at runtime instead of bundling a provider', () => {
    expect(manifest.dependencies).not.toHaveProperty('dsh-better-sidebar')
    expect(manifest.peerDependencies?.['dsh-better-sidebar']).toBe('^0.12.1')
    expect(manifest.peerDependenciesMeta?.['dsh-better-sidebar']?.optional).toBe(true)
    expect(manifest.dsh?.client?.inject).not.toContain('dsh-better-sidebar')
  })
})
