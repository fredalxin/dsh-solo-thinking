import { describe, expect, it } from 'vitest'
import { createSpace, splitNode, DEFAULT_LIMITS } from '../src/domain.js'
import { computeOrbitLayout } from '../src/client/layout.js'

describe('orbit layout', () => {
  it('keeps the root centered and deeper branches on outer rings', () => {
    let space = createSpace('root', 'Root', 1)
    space = splitNode(space, 'root', {
      id: 'a', sessionId: 'a-session', title: 'A', inheritedHandoff: '# Handoff\nA',
    }, DEFAULT_LIMITS, 2)
    space = splitNode(space, 'a', {
      id: 'a1', sessionId: 'a1-session', title: 'A1', inheritedHandoff: '# Handoff\nA1',
    }, DEFAULT_LIMITS, 3)

    const layout = computeOrbitLayout(space, 800, 600)
    const root = layout.points.find((point) => point.node.id === 'root')!
    const child = layout.points.find((point) => point.node.id === 'a')!
    const grandchild = layout.points.find((point) => point.node.id === 'a1')!
    const radius = (point: typeof root) => Math.hypot(point.x - 400, point.y - 300)

    expect(root).toMatchObject({ x: 400, y: 300 })
    expect(radius(child)).toBeGreaterThan(0)
    expect(radius(grandchild)).toBeGreaterThan(radius(child))
  })
})
