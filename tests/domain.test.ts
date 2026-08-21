import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  activateNode,
  beginCheckpointNode,
  beginReturnNode,
  cancelCheckpointNode,
  cancelReturnNode,
  checkpointNode,
  completeSplitHandoff,
  createSpace,
  endSpace,
  nodeForSession,
  renameNode,
  renderBranchContext,
  returnNode,
  requestSplitNode,
  retrySplitHandoffNode,
  splitNode,
  suggestNodes,
} from '../src/domain.js'

const handoff = (topic: string) => `# Handoff\n\n## Objective\n${topic}\n\n## Next action\nContinue the branch.`

describe('Solo Thinking domain', () => {
  it('creates isolated child identities with only an explicit Handoff', () => {
    const root = createSpace('session-root', 'Launch idea', 1)
    const child = splitNode(root, 'session-root', {
      id: 'node-market',
      sessionId: 'session-market',
      title: 'Market signal',
      inheritedHandoff: handoff('Validate demand'),
    }, DEFAULT_LIMITS, 2)

    expect(child.revision).toBe(1)
    expect(nodeForSession(child, 'session-market')).toMatchObject({
      parentId: 'session-root',
      depth: 1,
      inheritedHandoff: handoff('Validate demand'),
      status: 'active',
    })
    expect(nodeForSession(child, 'session-root')?.inheritedHandoff).toBeUndefined()
  })

  it('enforces sibling title and fan-out limits before mutation', () => {
    const root = createSpace('root', 'Root', 1)
    const one = splitNode(root, 'root', {
      id: 'one', sessionId: 'one-session', title: 'Evidence', inheritedHandoff: handoff('One'),
    }, { ...DEFAULT_LIMITS, maxBranches: 1 }, 2)

    expect(() => splitNode(one, 'root', {
      id: 'two', sessionId: 'two-session', title: 'Other', inheritedHandoff: handoff('Two'),
    }, { ...DEFAULT_LIMITS, maxBranches: 1 }, 3)).toThrow('Branch limit')
    expect(one.nodes).toHaveLength(2)
  })

  it('creates one initial batch of up to four dormant suggested directions', () => {
    const root = createSpace('root', 'Root', 1)
    const suggested = suggestNodes(root, 'root', [
      { id: 'a', sessionId: 'session-a', title: 'Brand', inheritedHandoff: handoff('Brand direction') },
      { id: 'b', sessionId: 'session-b', title: 'Finance', inheritedHandoff: handoff('Finance direction') },
      { id: 'c', sessionId: 'session-c', title: 'Partnership', inheritedHandoff: handoff('Partnership direction') },
      { id: 'd', sessionId: 'session-d', title: 'Location', inheritedHandoff: handoff('Location direction') },
    ], DEFAULT_LIMITS, 2)

    expect(suggested.revision).toBe(4)
    expect(suggested.nodes.filter((node) => node.parentId === 'root')).toHaveLength(4)
    expect(suggested.nodes.filter((node) => node.parentId === 'root').every((node) => node.dormant)).toBe(true)
    expect(() => suggestNodes(suggested, 'root', [
      { id: 'e', sessionId: 'session-e', title: 'Extra', inheritedHandoff: handoff('Extra') },
      { id: 'f', sessionId: 'session-f', title: 'More', inheritedHandoff: handoff('More') },
    ], DEFAULT_LIMITS, 3)).toThrow('before this branch has children')
    expect(() => suggestNodes(root, 'root', [
      { id: 'only', sessionId: 'session-only', title: 'Only', inheritedHandoff: handoff('Only') },
    ], DEFAULT_LIMITS, 3)).toThrow('require 2–4')
  })

  it('persists dormancy until a branch actually starts', () => {
    const root = createSpace('root', 'Root', 1)
    const created = splitNode(root, 'root', {
      id: 'child', sessionId: 'child-session', title: 'Child', inheritedHandoff: handoff('Child'),
    }, DEFAULT_LIMITS, 2)
    expect(nodeForSession(created, 'child-session')?.dormant).toBe(true)

    const started = activateNode(created, 'child', 3)
    expect(started.revision).toBe(2)
    expect(nodeForSession(started, 'child-session')?.dormant).toBeUndefined()
    expect(activateNode(started, 'child', 4)).toBe(started)
  })

  it('publishes checkpoints for siblings without exposing raw dialogue', () => {
    let space = createSpace('root', 'Root', 1)
    space = splitNode(space, 'root', {
      id: 'research', sessionId: 'research-session', title: 'Research', inheritedHandoff: handoff('Research scope'),
    }, DEFAULT_LIMITS, 2)
    space = splitNode(space, 'root', {
      id: 'design', sessionId: 'design-session', title: 'Design', inheritedHandoff: handoff('Design scope'),
    }, DEFAULT_LIMITS, 3)
    space = checkpointNode(space, 'research', handoff('Confirmed signal A'), DEFAULT_LIMITS, 4)

    const context = renderBranchContext(space, 'design')
    expect(context).toContain('Confirmed signal A')
    expect(context).toContain('Raw conversations are isolated')
    expect(context).toContain('Default suggested-direction mode is ON')
    expect(context).toContain('Never merely present a numbered list')
    expect(context).not.toContain('private transcript')
  })

  it('keeps a human split read-only until its parent Agent completes the targeted Handoff', () => {
    let space = createSpace('root', 'Root', 1)
    space = requestSplitNode(space, 'root', {
      id: 'pending', sessionId: 'pending-session', title: 'Pending branch',
    }, true, DEFAULT_LIMITS, 2)

    expect(nodeForSession(space, 'pending-session')).toMatchObject({
      forkHandoffPending: true,
      forkHandoffRequestedAt: 2,
    })
    expect(() => checkpointNode(space, 'pending', handoff('Too early'), DEFAULT_LIMITS, 3)).toThrow('preparing inherited context')
    expect(() => completeSplitHandoff(space, 'someone-else', 'pending', handoff('Wrong parent'), DEFAULT_LIMITS, 3)).toThrow()

    space = retrySplitHandoffNode(space, 'root', 'pending', 4)
    expect(nodeForSession(space, 'pending-session')).toMatchObject({ forkHandoffRequestedAt: 4 })
    space = completeSplitHandoff(space, 'root', 'pending', handoff('Targeted child context'), DEFAULT_LIMITS, 5)
    expect(nodeForSession(space, 'pending-session')).toMatchObject({
      forkHandoffPending: false,
      inheritedHandoff: handoff('Targeted child context'),
      updatedAt: 5,
    })
    expect(nodeForSession(space, 'pending-session')?.forkHandoffRequestedAt).toBeUndefined()
  })

  it('creates an empty-parent child ready without manufacturing a Handoff', () => {
    const space = requestSplitNode(createSpace('root', 'Root', 1), 'root', {
      id: 'ready', sessionId: 'ready-session', title: 'Ready branch',
    }, false, DEFAULT_LIMITS, 2)
    expect(nodeForSession(space, 'ready-session')).toMatchObject({ status: 'active' })
    expect(nodeForSession(space, 'ready-session')?.forkHandoffPending).toBeUndefined()
    expect(nodeForSession(space, 'ready-session')?.inheritedHandoff).toBeUndefined()
  })

  it('locks Current State refresh and preserves the previous checkpoint on recovery', () => {
    let space = checkpointNode(createSpace('root', 'Root', 1), 'root', handoff('Version one'), DEFAULT_LIMITS, 2)
    space = beginCheckpointNode(space, 'root', 3)
    expect(nodeForSession(space, 'root')).toMatchObject({
      checkpointHandoff: handoff('Version one'),
      checkpointRefreshingAt: 3,
    })
    expect(() => splitNode(space, 'root', {
      id: 'blocked', sessionId: 'blocked-session', title: 'Blocked', inheritedHandoff: handoff('Blocked'),
    }, DEFAULT_LIMITS, 4)).toThrow('refreshing Current State')

    space = cancelCheckpointNode(space, 'root', 5)
    expect(nodeForSession(space, 'root')).toMatchObject({ checkpointHandoff: handoff('Version one') })
    expect(nodeForSession(space, 'root')?.checkpointRefreshingAt).toBeUndefined()

    space = beginCheckpointNode(space, 'root', 6)
    space = checkpointNode(space, 'root', handoff('Version two'), DEFAULT_LIMITS, 7)
    expect(nodeForSession(space, 'root')).toMatchObject({
      checkpointHandoff: handoff('Version two'),
      checkpointAt: 7,
    })
    expect(nodeForSession(space, 'root')?.checkpointRefreshingAt).toBeUndefined()
  })

  it('blocks parent return until children return, then seals both nodes', () => {
    let space = createSpace('root', 'Root', 1)
    space = splitNode(space, 'root', {
      id: 'parent', sessionId: 'parent-session', title: 'Parent', inheritedHandoff: handoff('Parent'),
    }, DEFAULT_LIMITS, 2)
    space = splitNode(space, 'parent', {
      id: 'child', sessionId: 'child-session', title: 'Child', inheritedHandoff: handoff('Child'),
    }, DEFAULT_LIMITS, 3)

    expect(() => returnNode(space, 'parent', handoff('Parent done'), DEFAULT_LIMITS, 4)).toThrow('still active')
    space = returnNode(space, 'child', handoff('Child done'), DEFAULT_LIMITS, 5)
    space = returnNode(space, 'parent', handoff('Parent done'), DEFAULT_LIMITS, 6)

    expect(nodeForSession(space, 'child-session')?.status).toBe('returned')
    expect(nodeForSession(space, 'parent-session')?.status).toBe('returned')
    expect(() => checkpointNode(space, 'parent', handoff('Too late'), DEFAULT_LIMITS, 7)).toThrow('has returned')
  })

  it('never allows the root node to return', () => {
    const space = createSpace('root', 'Root', 1)
    expect(() => returnNode(space, 'root', handoff('Done'), DEFAULT_LIMITS, 2)).toThrow('root')
  })

  it('ends a whole space without deleting its branch history', () => {
    const space = splitNode(createSpace('root', 'Root', 1), 'root', {
      id: 'child', sessionId: 'child-session', title: 'Child', inheritedHandoff: handoff('Child'),
    }, DEFAULT_LIMITS, 2)
    const ended = endSpace(space, 3)

    expect(ended).toMatchObject({ revision: 2, endedAt: 3 })
    expect(ended.nodes).toEqual(space.nodes)
    expect(() => endSpace(ended, 4)).toThrow('already ended')
  })

  it('locks a branch while its Agent prepares the final Handoff and can recover', () => {
    let space = createSpace('root', 'Root', 1)
    space = splitNode(space, 'root', {
      id: 'child', sessionId: 'child-session', title: 'Child', inheritedHandoff: handoff('Child'),
    }, DEFAULT_LIMITS, 2)

    space = beginReturnNode(space, 'child', 3)
    expect(nodeForSession(space, 'child-session')).toMatchObject({
      status: 'returning', returningAt: 3, updatedAt: 3,
    })
    expect(() => checkpointNode(space, 'child', handoff('Too late'), DEFAULT_LIMITS, 4)).toThrow('preparing a return')
    expect(() => splitNode(space, 'child', {
      id: 'grandchild', sessionId: 'grandchild-session', title: 'Grandchild', inheritedHandoff: handoff('Late'),
    }, DEFAULT_LIMITS, 4)).toThrow('preparing a return')

    space = cancelReturnNode(space, 'child', 5)
    expect(nodeForSession(space, 'child-session')).toMatchObject({ status: 'active', updatedAt: 5 })
    expect(nodeForSession(space, 'child-session')?.returningAt).toBeUndefined()

    space = beginReturnNode(space, 'child', 6)
    space = returnNode(space, 'child', handoff('Done'), DEFAULT_LIMITS, 7)
    expect(nodeForSession(space, 'child-session')).toMatchObject({ status: 'returned', returnedAt: 7 })
    expect(nodeForSession(space, 'child-session')?.returningAt).toBeUndefined()
  })

  it('lets the human rename an active visual branch', () => {
    const space = renameNode(createSpace('root', 'Root', 1), 'root', '  New direction  ', 2)
    expect(space.revision).toBe(1)
    expect(nodeForSession(space, 'root')).toMatchObject({ title: 'New direction', updatedAt: 2 })
  })
})
