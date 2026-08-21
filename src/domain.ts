import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const THINKING_STATE_EVENT = 'solo-thinking/state' as const
export const THINKING_PROJECTION = 'soloThinking' as const

export type ThinkingNodeStatus = 'active' | 'returning' | 'returned'

export interface ThinkingNode {
  id: string
  sessionId: string
  parentId: string | null
  title: string
  depth: number
  sortOrder: number
  status: ThinkingNodeStatus
  dormant?: boolean | undefined
  forkHandoffPending?: boolean | undefined
  inheritedHandoff?: string | undefined
  checkpointHandoff?: string | undefined
  returnedHandoff?: string | undefined
  createdAt: number
  updatedAt: number
  forkHandoffRequestedAt?: number | undefined
  checkpointRefreshingAt?: number | undefined
  checkpointAt?: number | undefined
  returningAt?: number | undefined
  returnedAt?: number | undefined
}

export interface ThinkingSpace {
  version: 1
  revision: number
  rootSessionId: string
  endedAt?: number | undefined
  nodes: ThinkingNode[]
}

export interface ThinkingLimits {
  maxDepth: number
  maxBranches: number
  maxNodes: number
  maxHandoffChars: number
}

export const DEFAULT_LIMITS: ThinkingLimits = {
  maxDepth: 4,
  maxBranches: 6,
  maxNodes: 40,
  maxHandoffChars: 8_000,
}

export const DEFAULT_SUGGESTED_BRANCH_COUNT = 4

const nodeSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  title: z.string().min(1),
  depth: z.number().int().nonnegative(),
  sortOrder: z.number().int().nonnegative(),
  status: z.enum(['active', 'returning', 'returned']),
  dormant: z.boolean().optional(),
  forkHandoffPending: z.boolean().optional(),
  inheritedHandoff: z.string().optional(),
  checkpointHandoff: z.string().optional(),
  returnedHandoff: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  forkHandoffRequestedAt: z.number().int().nonnegative().optional(),
  checkpointRefreshingAt: z.number().int().nonnegative().optional(),
  checkpointAt: z.number().int().nonnegative().optional(),
  returningAt: z.number().int().nonnegative().optional(),
  returnedAt: z.number().int().nonnegative().optional(),
})

export const thinkingSpaceSchema: z.ZodType<ThinkingSpace> = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  rootSessionId: z.string().min(1),
  endedAt: z.number().int().nonnegative().optional(),
  nodes: z.array(nodeSchema).min(1),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'solo-thinking/state': {
      space: ThinkingSpace
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    soloThinking: ThinkingSpace | null
  }
}

export function createSpace(rootSessionId: string, rootTitle: string, now: number): ThinkingSpace {
  const title = normalizeTitle(rootTitle)
  return {
    version: 1,
    revision: 0,
    rootSessionId,
    nodes: [{
      id: rootSessionId,
      sessionId: rootSessionId,
      parentId: null,
      title,
      depth: 0,
      sortOrder: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }],
  }
}

export function foldThinkingSpace(events: readonly SessionEvent[]): ThinkingSpace | null {
  let state: ThinkingSpace | null = null
  for (const event of events) {
    if (event.type === THINKING_STATE_EVENT) {
      state = thinkingSpaceSchema.parse(event.data.space)
    }
  }
  return state
}

export function nodeForSession(space: ThinkingSpace, sessionId: string): ThinkingNode | undefined {
  return space.nodes.find((node) => node.sessionId === sessionId)
}

export function nodeById(space: ThinkingSpace, nodeId: string): ThinkingNode {
  const node = space.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new Error(`Thinking node "${nodeId}" does not exist`)
  return node
}

export function endSpace(space: ThinkingSpace, now: number): ThinkingSpace {
  if (space.endedAt !== undefined) throw new Error('Thinking space has already ended')
  return { ...space, revision: space.revision + 1, endedAt: now }
}

export function splitNode(
  space: ThinkingSpace,
  parentId: string,
  child: { id: string; sessionId: string; title: string; inheritedHandoff: string },
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  const inheritedHandoff = normalizeHandoff(child.inheritedHandoff, limits.maxHandoffChars)
  return addChildNode(space, parentId, child, { inheritedHandoff }, limits, now)
}

export function suggestNodes(
  space: ThinkingSpace,
  parentId: string,
  children: readonly { id: string; sessionId: string; title: string; inheritedHandoff: string }[],
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  requireActive(space, parentId)
  if (parentId !== space.rootSessionId) {
    throw new Error('Automatic suggestions are only available for the initial root fan-out')
  }
  if (children.length < 2 || children.length > DEFAULT_SUGGESTED_BRANCH_COUNT) {
    throw new Error(`Automatic suggestions require 2–${DEFAULT_SUGGESTED_BRANCH_COUNT} directions`)
  }
  if (space.nodes.some((node) => node.parentId === parentId)) {
    throw new Error('Automatic suggestions are only available before this branch has children')
  }

  return children.reduce((current, child) => (
    splitNode(current, parentId, child, limits, now)
  ), space)
}

export function requestSplitNode(
  space: ThinkingSpace,
  parentId: string,
  child: { id: string; sessionId: string; title: string },
  requiresHandoff: boolean,
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  return addChildNode(space, parentId, child, requiresHandoff ? {
    forkHandoffPending: true,
    forkHandoffRequestedAt: now,
  } : {}, limits, now)
}

export function activateNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace {
  const node = nodeById(space, nodeId)
  if (!node.dormant) return space
  const { dormant: _dormant, ...startedNode } = node
  return replaceNode(space, node.id, {
    ...startedNode,
    updatedAt: now,
  })
}

export function retrySplitHandoffNode(
  space: ThinkingSpace,
  parentId: string,
  childId: string,
  now: number,
): ThinkingSpace {
  requireActive(space, parentId)
  const child = nodeById(space, childId)
  if (child.parentId !== parentId || !child.forkHandoffPending) {
    throw new Error('Thinking child is not waiting for this parent Handoff')
  }
  return replaceNode(space, child.id, {
    ...child,
    forkHandoffRequestedAt: now,
    updatedAt: now,
  })
}

export function completeSplitHandoff(
  space: ThinkingSpace,
  parentId: string,
  childId: string,
  handoff: string,
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  requireActive(space, parentId)
  const child = nodeById(space, childId)
  if (child.parentId !== parentId || !child.forkHandoffPending) {
    throw new Error('Thinking child is not waiting for this parent Handoff')
  }
  const inheritedHandoff = normalizeHandoff(handoff, limits.maxHandoffChars)
  const { forkHandoffRequestedAt: _requestedAt, ...stableChild } = child
  return replaceNode(space, child.id, {
    ...stableChild,
    forkHandoffPending: false,
    inheritedHandoff,
    updatedAt: now,
  })
}

function addChildNode(
  space: ThinkingSpace,
  parentId: string,
  child: { id: string; sessionId: string; title: string },
  handoffState: Pick<ThinkingNode, 'forkHandoffPending' | 'forkHandoffRequestedAt' | 'inheritedHandoff'>,
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  const parent = requireActive(space, parentId)
  if (parent.depth >= limits.maxDepth) {
    throw new Error(`Thinking depth limit (${limits.maxDepth}) reached`)
  }
  if (space.nodes.length >= limits.maxNodes) {
    throw new Error(`Thinking node limit (${limits.maxNodes}) reached`)
  }

  const siblings = space.nodes.filter((node) => node.parentId === parent.id)
  if (siblings.length >= limits.maxBranches) {
    throw new Error(`Branch limit (${limits.maxBranches}) reached for this node`)
  }

  const title = normalizeTitle(child.title)
  if (siblings.some((node) => node.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
    throw new Error(`A sibling branch named "${title}" already exists`)
  }
  if (space.nodes.some((node) => node.id === child.id || node.sessionId === child.sessionId)) {
    throw new Error('Thinking child identity already exists')
  }

  return {
    ...space,
    revision: space.revision + 1,
    nodes: [...space.nodes, {
      id: child.id,
      sessionId: child.sessionId,
      parentId: parent.id,
      title,
      depth: parent.depth + 1,
      sortOrder: siblings.length,
      status: 'active',
      dormant: true,
      ...handoffState,
      createdAt: now,
      updatedAt: now,
    }],
  }
}

export function checkpointNode(
  space: ThinkingSpace,
  nodeId: string,
  handoff: string,
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  const node = requireActive(space, nodeId, true)
  const checkpointHandoff = normalizeHandoff(handoff, limits.maxHandoffChars)
  const { checkpointRefreshingAt: _refreshingAt, ...stableNode } = node
  return replaceNode(space, node.id, {
    ...stableNode,
    checkpointHandoff,
    checkpointAt: now,
    updatedAt: now,
  })
}

export function beginCheckpointNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace {
  const node = requireActive(space, nodeId)
  if (node.checkpointRefreshingAt !== undefined) {
    throw new Error(`Thinking branch "${node.title}" is already refreshing Current State`)
  }
  return replaceNode(space, node.id, {
    ...node,
    checkpointRefreshingAt: now,
    updatedAt: now,
  })
}

export function cancelCheckpointNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace {
  const node = nodeById(space, nodeId)
  if (node.checkpointRefreshingAt === undefined) {
    throw new Error(`Thinking branch "${node.title}" is not refreshing Current State`)
  }
  const { checkpointRefreshingAt: _refreshingAt, ...activeNode } = node
  return replaceNode(space, node.id, {
    ...activeNode,
    updatedAt: now,
  })
}

export function renameNode(
  space: ThinkingSpace,
  nodeId: string,
  title: string,
  now: number,
): ThinkingSpace {
  const node = requireActive(space, nodeId)
  return replaceNode(space, node.id, {
    ...node,
    title: normalizeTitle(title),
    updatedAt: now,
  })
}

export function returnNode(
  space: ThinkingSpace,
  nodeId: string,
  handoff: string,
  limits: ThinkingLimits,
  now: number,
): ThinkingSpace {
  const node = requireReturnable(space, nodeId)
  assertReturnTopology(space, node)

  const returnedHandoff = normalizeHandoff(handoff, limits.maxHandoffChars)
  const { returningAt: _returningAt, ...stableNode } = node
  return replaceNode(space, node.id, {
    ...stableNode,
    status: 'returned',
    returnedHandoff,
    updatedAt: now,
    returnedAt: now,
  })
}

export function beginReturnNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace {
  const node = requireActive(space, nodeId)
  assertReturnTopology(space, node)
  return replaceNode(space, node.id, {
    ...node,
    status: 'returning',
    returningAt: now,
    updatedAt: now,
  })
}

export function cancelReturnNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace {
  const node = nodeById(space, nodeId)
  if (node.status !== 'returning') {
    throw new Error(`Thinking branch "${node.title}" is not preparing a return`)
  }
  const { returningAt: _returningAt, ...activeNode } = node
  return replaceNode(space, node.id, {
    ...activeNode,
    status: 'active',
    updatedAt: now,
  })
}

export function renderBranchContext(space: ThinkingSpace, nodeId: string): string {
  const node = nodeById(space, nodeId)
  const parent = node.parentId === null ? undefined : nodeById(space, node.parentId)
  const siblings = space.nodes.filter((candidate) => (
    candidate.parentId === node.parentId && candidate.id !== node.id
  ))
  const returnedChildren = space.nodes.filter((candidate) => (
    candidate.parentId === node.id && candidate.status === 'returned'
  ))

  const lines = [
    '# Solo Thinking branch',
    `Current branch: ${node.title} (${node.status})`,
    parent ? `Parent branch: ${parent.title}` : 'This is the root branch.',
    '',
    'Raw conversations are isolated by DSH Session. Never infer or request another branch\'s raw transcript.',
    'Default suggested-direction mode is ON for the root branch. When the root has no children and enough context exists, identify 2–4 genuinely independent high-value directions (prefer exactly 4) and create them together with thinking_suggest before asking the user which direction to enter.',
    'Never merely present a numbered list of future directions: if you show multiple next directions, the matching child nodes must already exist. Do not split when the user explicitly asks to stay linear, or when fewer than two genuinely independent directions exist. Suggested branches are created dormant and must not be auto-run.',
    'After the initial root batch, use thinking_split for any later one-off child branch. Do not recursively fan every suggested child into another automatic batch.',
    'After the first meaningful reply, publish an outward Current State with thinking_checkpoint. Update it only when cross-branch-relevant objectives, conclusions, evidence, risks, dependencies, unresolved work, or next action materially change.',
    'Use thinking_split only with a child-specific Handoff. Use thinking_return only when this non-root branch is ready to seal.',
  ]

  if (node.status === 'returned') {
    lines.push('', 'This branch has returned and is read-only for Thinking mutations.')
  } else if (node.status === 'returning') {
    lines.push('', 'This branch is preparing its final parent Handoff. Call thinking_return with the final Markdown transfer; do not continue ordinary branch work.')
  } else if (node.forkHandoffPending) {
    lines.push('', 'This branch is waiting for its parent-authored fork Handoff and cannot start yet.')
  }
  if (node.inheritedHandoff) {
    lines.push('', '## From parent', node.inheritedHandoff)
  }

  lines.push('', '## Related branches')
  if (siblings.length === 0) {
    lines.push('No sibling branch has been created.')
  } else {
    for (const sibling of siblings) {
      const state = sibling.returnedHandoff ?? sibling.checkpointHandoff
      const label = sibling.status === 'returned'
        ? 'final'
        : sibling.forkHandoffPending
          ? 'preparing inherited context'
          : 'current state'
      lines.push(`### ${sibling.title} — ${label}`, state ?? 'No state published.')
    }
  }

  if (returnedChildren.length > 0) {
    lines.push('', '## Returned children')
    for (const child of returnedChildren) {
      lines.push(`### ${child.title}`, child.returnedHandoff ?? 'No final Handoff recorded.')
    }
  }

  return lines.join('\n')
}

function replaceNode(space: ThinkingSpace, id: string, replacement: ThinkingNode): ThinkingSpace {
  return {
    ...space,
    revision: space.revision + 1,
    nodes: space.nodes.map((node) => node.id === id ? replacement : node),
  }
}

function requireActive(space: ThinkingSpace, nodeId: string, allowCheckpointRefresh = false): ThinkingNode {
  const node = nodeById(space, nodeId)
  if (node.status !== 'active') {
    throw new Error(`Thinking branch "${node.title}" ${node.status === 'returning' ? 'is preparing a return' : 'has returned'}`)
  }
  if (node.forkHandoffPending) {
    throw new Error(`Thinking branch "${node.title}" is preparing inherited context`)
  }
  if (!allowCheckpointRefresh && node.checkpointRefreshingAt !== undefined) {
    throw new Error(`Thinking branch "${node.title}" is refreshing Current State`)
  }
  return node
}

function requireReturnable(space: ThinkingSpace, nodeId: string): ThinkingNode {
  const node = nodeById(space, nodeId)
  if (node.status === 'returned') throw new Error(`Thinking branch "${node.title}" has returned`)
  if (node.forkHandoffPending) throw new Error(`Thinking branch "${node.title}" is preparing inherited context`)
  if (node.checkpointRefreshingAt !== undefined) throw new Error(`Thinking branch "${node.title}" is refreshing Current State`)
  return node
}

function assertReturnTopology(space: ThinkingSpace, node: ThinkingNode): void {
  if (node.parentId === null) throw new Error('The root Thinking node cannot return')
  const activeChild = space.nodes.find((candidate) => (
    candidate.parentId === node.id && candidate.status !== 'returned'
  ))
  if (activeChild) {
    throw new Error(`Return blocked: child branch "${activeChild.title}" is still active`)
  }
}

function normalizeTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title) throw new Error('Thinking branch title cannot be blank')
  if (title.length > 80) throw new Error('Thinking branch title must be at most 80 characters')
  return title
}

function normalizeHandoff(value: string, maxChars: number): string {
  const handoff = value.trim()
  if (!handoff) throw new Error('Thinking Handoff cannot be blank')
  if (handoff.length > maxChars) {
    throw new Error(`Thinking Handoff must be at most ${maxChars} characters`)
  }
  return handoff
}
