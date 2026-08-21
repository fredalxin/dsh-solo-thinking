import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_LIMITS,
  THINKING_PROJECTION,
  THINKING_STATE_EVENT,
  activateNode,
  beginCheckpointNode,
  beginReturnNode,
  cancelCheckpointNode,
  cancelReturnNode,
  checkpointNode,
  completeSplitHandoff,
  createSpace,
  endSpace,
  foldThinkingSpace,
  nodeById,
  nodeForSession,
  renderBranchContext,
  renameNode,
  requestSplitNode,
  retrySplitHandoffNode,
  returnNode,
  splitNode,
  suggestNodes,
  thinkingSpaceSchema,
  type ThinkingLimits,
  type ThinkingSpace,
} from './domain.js'
import { installRcEventCatalogEntry } from './rc-event-catalog.js'

export * from './domain.js'
export { installRcEventCatalogEntry } from './rc-event-catalog.js'

export const name = 'dsh-plugin-solo-thinking'
export const inject = ['agents', 'sessions', 'systemPrompt', 'tools', 'workspaceRegistry']

const RETURN_REQUEST_MARKER = '[solo-thinking:return-request]'
const SPLIT_REQUEST_MARKER = '[solo-thinking:split-request]'
const CHECKPOINT_REQUEST_MARKER = '[solo-thinking:checkpoint-request]'
const CONTROL_NOTICE_SOURCE = 'dsh-plugin-solo-thinking:control'
const RETURN_NOTICE_SOURCE = 'dsh-plugin-solo-thinking:return'

export interface Config extends Partial<ThinkingLimits> {
  rootTitle?: string
}

export const Config = z.object({
  rootTitle: z.string().default('Brainstorm'),
  maxDepth: z.natural().min(1).default(DEFAULT_LIMITS.maxDepth),
  maxBranches: z.natural().min(1).default(DEFAULT_LIMITS.maxBranches),
  maxNodes: z.natural().min(2).default(DEFAULT_LIMITS.maxNodes),
  maxHandoffChars: z.natural().min(200).default(DEFAULT_LIMITS.maxHandoffChars),
})

interface ResolvedConfig extends ThinkingLimits {
  rootTitle: string
}

interface SuggestedDirection {
  title: string
  handoff: string
}

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', const: true, required: true },
    message: { type: 'string', required: true },
    sessionId: { type: 'string' },
    revision: { type: 'integer', required: true },
  },
} as const

type ToolResult = {
  ok: true
  message: string
  sessionId?: string
  revision: number
}

export function apply(ctx: Context, rawConfig: Config = {}): void {
  const config = resolveConfig(rawConfig)
  const handles = new Map<string, AgentHandle>()
  const writes = new Map<string, Promise<void>>()

  ctx.effect(() => installRcEventCatalogEntry(ctx.sessions), 'solo-thinking: DSH RC event catalog')

  ctx.effect(() => async () => {
    const owned = [...handles.values()]
    handles.clear()
    await Promise.allSettled(owned.map((handle) => handle.dispose()))
  }, 'solo-thinking: child agents')

  const startThinking = async (agent: Agent, title?: string): Promise<ToolResult> => (
    serializeWrite(writes, agent.session.id, async () => {
      const existing = locateSpace(ctx, agent.session.id)
      if (existing) {
        return success(`Thinking is already active at "${existing.node.title}".`, existing.space)
      }
      const space = createSpace(agent.session.id, title ?? config.rootTitle, Date.now())
      await appendSpace(ctx, [agent.session], space)
      return success('Thinking started. Default suggestion mode is on: create the initial 2–4 directions with thinking_suggest once enough context exists.', space)
    })
  )

  const splitThinking = async (parentAgent: Agent, title: string, handoff: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, parentAgent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, parentAgent)
      const childId = `thinking-${globalThis.crypto.randomUUID()}`
      const childSessionId = SessionId(childId)
      const next = splitNode(located.space, located.node.id, {
        id: childId,
        sessionId: childSessionId,
        title,
        inheritedHandoff: handoff,
      }, config, Date.now())

      const handle = await createChildHandle(ctx, parentAgent, childSessionId)

      try {
        await appendSpace(ctx, liveSessions(ctx, next), next)
        handles.set(childSessionId, handle)
      } catch (error) {
        await handle.dispose()
        throw error
      }

      return success(`Created isolated branch "${title}". It is ready for you or the Agent to open.`, next, childSessionId)
    })
  }

  const suggestThinking = async (
    parentAgent: Agent,
    directions: readonly SuggestedDirection[],
  ): Promise<ToolResult> => {
    const initial = requireSpace(ctx, parentAgent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, parentAgent)
      const branches = directions.map((direction) => {
        const id = `thinking-${globalThis.crypto.randomUUID()}`
        return {
          id,
          sessionId: SessionId(id),
          title: direction.title,
          inheritedHandoff: direction.handoff,
        }
      })
      const next = suggestNodes(located.space, located.node.id, branches, config, Date.now())
      const created: Array<{ sessionId: SessionId; handle: AgentHandle }> = []

      try {
        for (const branch of branches) {
          created.push({
            sessionId: branch.sessionId,
            handle: await createChildHandle(ctx, parentAgent, branch.sessionId),
          })
        }
        await appendSpace(ctx, liveSessions(ctx, next), next)
        for (const child of created) handles.set(child.sessionId, child.handle)
      } catch (error) {
        await Promise.allSettled(created.map(({ handle }) => handle.dispose()))
        throw error
      }

      return success(
        `Created ${branches.length} suggested branches: ${branches.map(({ title }) => `"${title.trim()}"`).join(', ')}. They remain dormant until explicitly opened.`,
        next,
      )
    })
  }

  const requestSplitThinking = async (parentAgent: Agent, title: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, parentAgent)
    const prepared = await serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, parentAgent)
      if (parentAgent.status !== 'idle') {
        throw new Error('Split blocked: this branch Agent is still running')
      }

      const childId = `thinking-${globalThis.crypto.randomUUID()}`
      const childSessionId = SessionId(childId)
      const requiresHandoff = hasConversation(parentAgent.session)
      const next = requestSplitNode(located.space, located.node.id, {
        id: childId,
        sessionId: childSessionId,
        title,
      }, requiresHandoff, config, Date.now())
      const handle = await createChildHandle(ctx, parentAgent, childSessionId)

      try {
        await appendSpace(ctx, liveSessions(ctx, next), next)
        handles.set(childSessionId, handle)
      } catch (error) {
        await handle.dispose()
        throw error
      }

      if (requiresHandoff) {
        parentAgent.followup(createControlMessage(
          renderSplitRequest(childId, title),
          `Prepare inherited Handoff for ${title}`,
        ))
        return { childId, childSessionId, requiresHandoff, space: next }
      }
      return { childId, childSessionId, requiresHandoff, space: next }
    })
    if (!prepared.requiresHandoff) {
      return success(`Created ready branch "${title}" without manufactured context because its parent is empty.`, prepared.space, prepared.childSessionId)
    }

    await parentAgent.whenIdle()
    const completed = requireSpace(ctx, parentAgent)
    const child = nodeById(completed.space, prepared.childId)
    if (child.forkHandoffPending) {
      throw new Error(`Inherited Handoff failed for "${child.title}". The pending branch is preserved; select it to retry.`)
    }
    return success(`Created "${child.title}" with an Agent-authored inherited Handoff.`, completed.space, prepared.childSessionId)
  }

  const retrySplitHandoffThinking = async (parentAgent: Agent, childId: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, parentAgent)
    const prepared = await serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, parentAgent)
      if (parentAgent.status !== 'idle') {
        throw new Error('Split retry blocked: the parent Agent is still running')
      }
      const child = nodeById(located.space, childId)
      const next = retrySplitHandoffNode(located.space, located.node.id, childId, Date.now())
      await appendSpace(ctx, liveSessions(ctx, next), next)
      parentAgent.followup(createControlMessage(
        renderSplitRequest(child.id, child.title),
        `Retry inherited Handoff for ${child.title}`,
      ))
      return { childSessionId: SessionId(child.sessionId), space: next }
    })
    await parentAgent.whenIdle()
    const completed = requireSpace(ctx, parentAgent)
    const child = nodeById(completed.space, childId)
    if (child.forkHandoffPending) {
      throw new Error(`Inherited Handoff failed again for "${child.title}". The branch remains pending.`)
    }
    return success(`Inherited Handoff is ready for "${child.title}".`, completed.space, prepared.childSessionId)
  }

  const completeSplitHandoffThinking = async (parentAgent: Agent, childId: string, handoff: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, parentAgent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, parentAgent)
      const child = nodeById(located.space, childId)
      const next = completeSplitHandoff(
        located.space, located.node.id, childId, handoff, config, Date.now(),
      )
      await appendSpace(ctx, liveSessions(ctx, next), next)
      return success(`Inherited Handoff prepared for "${child.title}".`, next, SessionId(child.sessionId))
    })
  }

  const checkpointThinking = async (agent: Agent, handoff: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, agent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, agent)
      const next = checkpointNode(located.space, located.node.id, handoff, config, Date.now())
      await appendSpace(ctx, liveSessions(ctx, next), next)
      return success(`Published Current State for "${located.node.title}".`, next)
    })
  }

  const requestCheckpointThinking = async (agent: Agent): Promise<ToolResult> => {
    const initial = requireSpace(ctx, agent)
    const refreshingAt = await serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, agent)
      if (agent.status !== 'idle') {
        throw new Error('Current State refresh blocked: this branch Agent is still running')
      }
      if (!hasConversation(agent.session)) {
        throw new Error('Current State refresh blocked: this branch has no conversation to summarize')
      }

      const refreshing = beginCheckpointNode(located.space, located.node.id, Date.now())
      await appendSpace(ctx, liveSessions(ctx, refreshing), refreshing)
      try {
        agent.followup(createControlMessage(
          renderCheckpointRequest(located.node.title),
          `Refresh Current State for ${located.node.title}`,
        ))
      } catch (error) {
        const active = cancelCheckpointNode(refreshing, located.node.id, Date.now())
        await appendSpace(ctx, liveSessions(ctx, active), active)
        throw error
      }
      return refreshing.nodes.find((node) => node.id === located.node.id)!.checkpointRefreshingAt!
    })
    await agent.whenIdle()
    const completed = requireSpace(ctx, agent)
    if (completed.node.checkpointAt === undefined || completed.node.checkpointAt < refreshingAt) {
      throw new Error(`Current State refresh failed for "${completed.node.title}". The previous Current State was preserved.`)
    }
    return success(`Agent refreshed Current State for "${completed.node.title}".`, completed.space)
  }

  const renameThinking = async (agent: Agent, title: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, agent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, agent)
      const next = renameNode(located.space, located.node.id, title, Date.now())
      await appendSpace(ctx, liveSessions(ctx, next), next)
      return success(`Renamed branch to "${title.trim()}".`, next)
    })
  }

  const requestReturnThinking = async (agent: Agent): Promise<ToolResult> => {
    const initial = requireSpace(ctx, agent)
    await serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, agent)
      if (agent.status !== 'idle') {
        throw new Error('Return blocked: this branch Agent is still running')
      }
      if (!hasConversation(agent.session)) {
        throw new Error('Return blocked: this branch has no conversation to summarize')
      }

      const returning = beginReturnNode(located.space, located.node.id, Date.now())
      await appendSpace(ctx, liveSessions(ctx, returning), returning)
      try {
        agent.followup(createControlMessage(
          renderReturnRequest(located.node.title),
          `Prepare final Handoff for ${located.node.title}`,
          RETURN_NOTICE_SOURCE,
        ))
      } catch (error) {
        const active = cancelReturnNode(returning, located.node.id, Date.now())
        await appendSpace(ctx, liveSessions(ctx, active), active)
        throw error
      }

      return returning
    })
    await agent.whenIdle()
    const completed = requireSpace(ctx, agent)
    if (completed.node.status !== 'returned') {
      throw new Error(`Final Handoff failed for "${completed.node.title}". The branch was restored and can be retried.`)
    }
    return success(`Returned "${completed.node.title}" to its parent and sealed the branch.`, completed.space)
  }

  const returnThinking = async (agent: Agent, handoff: string): Promise<ToolResult> => {
    const initial = requireSpace(ctx, agent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, agent)
      const next = returnNode(located.space, located.node.id, handoff, config, Date.now())
      const parent = nodeById(next, located.node.parentId!)
      await appendSpace(ctx, liveSessions(ctx, next), next, {
        sessionId: parent.sessionId,
        branchTitle: located.node.title,
        handoff,
      })

      return success(`Returned "${located.node.title}" to its parent and sealed the branch.`, next)
    })
  }

  const endThinking = async (agent: Agent): Promise<ToolResult> => {
    const initial = requireSpace(ctx, agent)
    return serializeWrite(writes, initial.space.rootSessionId, async () => {
      const located = requireSpace(ctx, agent)
      const ended = endSpace(located.space, Date.now())
      await appendSpace(ctx, liveSessions(ctx, ended), ended)
      return success('Thinking space ended. Start a new brainstorm in any former branch Session when ready.', ended)
    })
  }

  ctx.inject(['sessionProjections'], (projectionCtx) => projectionCtx.sessionProjections.register({
    key: THINKING_PROJECTION,
    schema: thinkingSpaceSchema.nullable(),
    init: () => null as ThinkingSpace | null,
    apply: (state, event) => event.type === THINKING_STATE_EVENT ? event.data.space : state,
    view: (state) => state?.endedAt === undefined ? state : null,
    stateVersion: 1,
  }))

  ctx.systemPrompt.context({
    name: 'solo-thinking:branch-context',
    order: 50,
    text: (assembly) => {
      const agent = assembly.agent
      if (!agent) return ''
      const located = locateSpace(ctx, agent.session.id)
      return located ? renderBranchContext(located.space, located.node.id) : ''
    },
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const located = locateSpace(ctx, agent.session.id)
    if (located?.node.status === 'returned' || located?.node.forkHandoffPending) return { kind: 'reject' }
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' || (event.type === 'user/message' && event.data.source.kind === 'user')) {
      queueMicrotask(() => {
        void markBranchStarted(ctx, writes, session.id).catch((error) => {
          ctx.logger.warn(`solo-thinking: failed to mark branch started: ${renderError(error)}`)
        })
      })
    }
    if (event.type === 'turn/end') {
      queueMicrotask(() => {
        void recoverIncompleteOperation(ctx, writes, session.id).catch((error) => {
          ctx.logger.warn(`solo-thinking: failed to recover transient state: ${renderError(error)}`)
        })
      })
    }
  })

  ctx.tools.register(defineTool({
    name: 'thinking_start',
    description: 'Start or read a Solo Thinking brainstorm space in the current DSH Session.',
    parameters: {
      title: {
        type: 'string',
        description: 'Short title for the root brainstorm branch. Omit to use the configured default.',
      },
    },
    output: outputContract('Start result'),
    execute: async (args, exec) => {
      const agent = requireAgent(exec)
      return startThinking(agent, args.title)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_fork_handoff',
    description: 'Complete a human-requested child split with the parent Agent\'s targeted inherited Handoff. Only the exact pending child may be completed.',
    parameters: {
      childId: {
        type: 'string',
        required: true,
        description: 'Exact pending child node id from the split request.',
      },
      handoff: {
        type: 'string',
        required: true,
        description: 'Child-specific Markdown Handoff: objective/scope, confirmed conclusions, evidence/artifacts, unresolved questions, risks/assumptions, and recommended first action.',
      },
    },
    output: outputContract('Fork Handoff result'),
    execute: async (args, exec) => {
      const parentAgent = requireAgent(exec)
      const result = await completeSplitHandoffThinking(parentAgent, args.childId, args.handoff)
      exec.concludeTurn()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_suggest',
    description: 'Default initial fan-out: create 2–4 (prefer exactly 4) genuinely distinct suggested child branches in one call. Use this before presenting multiple next directions; the branches stay dormant until explicitly opened.',
    parameters: {
      directions: {
        type: 'array',
        required: true,
        description: 'Two to four high-value, non-overlapping directions. Prefer exactly four; never add filler just to reach four.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: {
              type: 'string',
              required: true,
              description: 'Concise child branch title.',
            },
            handoff: {
              type: 'string',
              required: true,
              description: 'Child-specific Markdown Handoff: objective/scope, confirmed context, evidence, risks, open questions, and recommended first action.',
            },
          },
        },
      },
    },
    output: outputContract('Suggested branches result'),
    execute: async (args, exec) => {
      const parentAgent = requireAgent(exec)
      return suggestThinking(parentAgent, args.directions)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_split',
    description: 'Create an isolated child DSH Session. The handoff must be a branch-specific, agent-authored Markdown transfer; raw history is never copied.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Concise child branch title.',
      },
      handoff: {
        type: 'string',
        required: true,
        description: 'Markdown Handoff: objective/scope, confirmed context, evidence, risks, open questions, and recommended next action.',
      },
    },
    output: outputContract('Split result'),
    execute: async (args, exec) => {
      const parentAgent = requireAgent(exec)
      return splitThinking(parentAgent, args.title, args.handoff)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_checkpoint',
    description: 'Publish this active branch\'s latest cross-branch Current State without waking siblings.',
    parameters: {
      handoff: {
        type: 'string',
        required: true,
        description: 'Markdown Current State containing only cross-branch-relevant conclusions, evidence, risks, dependencies, and next action.',
      },
    },
    output: outputContract('Checkpoint result'),
    execute: async (args, exec) => {
      const agent = requireAgent(exec)
      const requestedRefresh = requireSpace(ctx, agent).node.checkpointRefreshingAt !== undefined
      const result = await checkpointThinking(agent, args.handoff)
      if (requestedRefresh) exec.concludeTurn()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_return',
    description: 'Return a final Handoff to the parent and terminally seal this non-root branch. All direct children must already be returned.',
    parameters: {
      handoff: {
        type: 'string',
        required: true,
        description: 'Final Markdown Handoff to the parent: conclusions, evidence/artifacts, unresolved risks, and recommended next action.',
      },
    },
    output: outputContract('Return result'),
    execute: async (args, exec) => {
      const agent = requireAgent(exec)
      const result = await returnThinking(agent, args.handoff)
      exec.concludeTurn()
      return result
    },
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_end',
    description: 'End the entire active Solo Thinking space. Only use when the user explicitly asks to end, reset, or clear this brainstorm.',
    parameters: {},
    output: outputContract('End result'),
    execute: async (_args, exec) => endThinking(requireAgent(exec)),
  }))

  ctx.tools.register(defineTool({
    name: 'thinking_status',
    description: 'Read the current Solo Thinking tree and this Session\'s branch lifecycle.',
    parameters: {},
    output: outputContract('Status result'),
    execute: async (_args, exec) => {
      const agent = requireAgent(exec)
      const located = requireSpace(ctx, agent)
      const active = located.space.nodes.filter((node) => node.status === 'active').length
      const returning = located.space.nodes.filter((node) => node.status === 'returning').length
      const returned = located.space.nodes.filter((node) => node.status === 'returned').length
      return success(
        `Branch "${located.node.title}" is ${located.node.status}. Tree: ${active} active, ${returning} returning, ${returned} returned, ${located.space.nodes.length} total.`,
        located.space,
      )
    },
  }))

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'thinking',
      description: 'Control the current Solo Thinking tree',
      input: { hint: 'start|split|split-retry|rename|checkpoint|return|end|status' },
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        try {
          const command = parseThinkingCommand(rawInput)
          let result: ToolResult
          switch (command.action) {
            case 'start':
              result = await startThinking(agent, command.title)
              break
            case 'split':
              result = await requestSplitThinking(agent, command.title)
              break
            case 'split-retry':
              result = await retrySplitHandoffThinking(agent, command.childId)
              break
            case 'rename':
              result = await renameThinking(agent, command.title)
              break
            case 'checkpoint':
              result = await requestCheckpointThinking(agent)
              break
            case 'return':
              result = await requestReturnThinking(agent)
              break
            case 'end':
              result = await endThinking(agent)
              break
            case 'status': {
              const located = requireSpace(ctx, agent)
              const active = located.space.nodes.filter((node) => node.status === 'active').length
              const returning = located.space.nodes.filter((node) => node.status === 'returning').length
              const returned = located.space.nodes.filter((node) => node.status === 'returned').length
              result = success(
                `Branch "${located.node.title}" is ${located.node.status}. Tree: ${active} active, ${returning} returning, ${returned} returned, ${located.space.nodes.length} total.`,
                located.space,
              )
              break
            }
          }
          return { kind: 'success' as const, text: `${result.message} Revision ${result.revision}.` }
        } catch (error) {
          return { kind: 'error' as const, text: renderError(error) }
        }
      },
    })
  })
}

type ThinkingCommand =
  | { action: 'start'; title?: string }
  | { action: 'split'; title: string }
  | { action: 'split-retry'; childId: string }
  | { action: 'rename'; title: string }
  | { action: 'checkpoint' }
  | { action: 'return' }
  | { action: 'end' }
  | { action: 'status' }

function parseThinkingCommand(rawInput: string): ThinkingCommand {
  const input = rawInput.trim()
  const separator = input.indexOf(' ')
  const action = separator === -1 ? input : input.slice(0, separator)
  const rawPayload = separator === -1 ? '' : input.slice(separator + 1).trim()
  if (action === 'status') return { action }
  if (action === 'return' && rawPayload === '') return { action }
  if (action === 'end' && rawPayload === '') return { action }
  if (action === 'checkpoint' && rawPayload === '') return { action }
  if (action === 'start' && rawPayload === '') return { action }

  let payload: unknown
  try {
    payload = JSON.parse(rawPayload)
  } catch {
    throw new Error('Invalid Thinking command payload')
  }
  if (!payload || typeof payload !== 'object') throw new Error('Invalid Thinking command payload')
  const record = payload as Record<string, unknown>

  if (action === 'start' || action === 'rename') {
    if (typeof record.title !== 'string') throw new Error('Thinking command requires a title')
    return { action, title: record.title }
  }
  if (action === 'split') {
    if (typeof record.title !== 'string') throw new Error('Thinking split requires a title')
    return { action, title: record.title }
  }
  if (action === 'split-retry') {
    if (typeof record.childId !== 'string') throw new Error('Thinking split retry requires a child id')
    return { action, childId: record.childId }
  }
  throw new Error('Use /thinking start, split, split-retry, rename, checkpoint, return, end, or status')
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderReturnRequest(title: string): string {
  return [
    RETURN_REQUEST_MARKER,
    `You are closing the Solo Thinking branch "${title}".`,
    'Review this branch conversation and call thinking_return exactly once with a concise final Markdown Handoff.',
    'Include conclusions, evidence or artifacts, unresolved risks, and the recommended next action for the parent branch.',
    'Do not continue ordinary branch work and do not give a normal final answer instead of calling the tool.',
  ].join('\n\n')
}

function renderSplitRequest(childId: string, title: string): string {
  return [
    SPLIT_REQUEST_MARKER,
    `Prepare the initial Handoff for the newly split child branch "${title}".`,
    `The exact pending child id is: ${childId}`,
    'Use the full context already present in this exact parent Agent Session. Do not continue ordinary work.',
    'Call thinking_fork_handoff exactly once with that childId and concise Markdown using these headings:',
    '# Handoff',
    '## Objective and scope',
    '## Confirmed conclusions',
    '## Evidence or artifacts',
    '## Unresolved questions',
    '## Risks and assumptions',
    '## Recommended first action',
  ].join('\n\n')
}

function renderCheckpointRequest(title: string): string {
  return [
    CHECKPOINT_REQUEST_MARKER,
    `Publish a fresh Current State for the Solo Thinking branch "${title}".`,
    'Use the full context already present in this exact Agent Session. Do not continue ordinary work and do not write a normal reply.',
    'Call thinking_checkpoint exactly once with concise Markdown using these headings:',
    '# Handoff',
    '## Objective and scope',
    '## Confirmed conclusions',
    '## Evidence or artifacts',
    '## Unresolved questions',
    '## Risks and assumptions',
    '## Recommended next action',
  ].join('\n\n')
}

function createControlMessage(text: string, summary: string, plugin = CONTROL_NOTICE_SOURCE) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin,
      form: 'notice',
      summary: boundContextSummary(summary),
    },
  })
}

function hasConversation(session: Session): boolean {
  return session.events.some((event) => (
    event.type === 'assistant/message'
    || (event.type === 'user/message' && event.data.source.kind === 'user')
  ))
}

function outputContract(label: string) {
  return {
    schema: resultSchema,
    render: (_args: unknown, value: ToolResult) => [{
      type: 'text' as const,
      text: `${label}: ${value.message}\nRevision: ${value.revision}${value.sessionId ? `\nSession: ${value.sessionId}` : ''}`,
    }],
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    rootTitle: config.rootTitle ?? 'Brainstorm',
    maxDepth: config.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxBranches: config.maxBranches ?? DEFAULT_LIMITS.maxBranches,
    maxNodes: config.maxNodes ?? DEFAULT_LIMITS.maxNodes,
    maxHandoffChars: config.maxHandoffChars ?? DEFAULT_LIMITS.maxHandoffChars,
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error(`${exec.name} requires a calling DSH Agent`)
  return exec.agent
}

function requireSpace(ctx: Context, agent: Agent) {
  const located = locateSpace(ctx, agent.session.id)
  if (!located) throw new Error('No Thinking space is active in this Session; call thinking_start first')
  return located
}

function locateSpace(ctx: Context, sessionId: SessionId) {
  let selected: { space: ThinkingSpace; node: ThinkingSpace['nodes'][number] } | undefined
  for (const session of ctx.sessions.list()) {
    const space = foldThinkingSpace(session.events)
    if (!space || space.endedAt !== undefined) continue
    const node = nodeForSession(space, sessionId)
    if (!node) continue
    if (!selected || space.revision > selected.space.revision) selected = { space, node }
  }
  return selected
}

function liveSessions(ctx: Context, space: ThinkingSpace): Session[] {
  const ids = new Set(space.nodes.map((node) => node.sessionId))
  return ctx.sessions.list().filter((session) => ids.has(session.id))
}

interface ReturnNotice {
  sessionId: string
  branchTitle: string
  handoff: string
}

async function appendSpace(
  ctx: Context,
  sessions: readonly Session[],
  space: ThinkingSpace,
  notice?: ReturnNotice,
): Promise<void> {
  const live = new Map(sessions.map((session) => [session.id, session]))
  for (const session of sessions) {
    const current = foldThinkingSpace(session.events)
    if (current?.revision !== space.revision) session.append(THINKING_STATE_EVENT, { space })
    if (notice?.sessionId === session.id) appendReturnNotice(session, notice)
  }

  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return

  for (const node of space.nodes) {
    const sessionId = SessionId(node.sessionId)
    if (live.has(sessionId)) continue

    const stored = await persistence.load(sessionId)
    const events: SessionEvent[] = []
    let seq = stored.events.length
    const current = foldThinkingSpace(stored.events)
    if (current?.revision !== space.revision) {
      events.push({
        type: THINKING_STATE_EVENT,
        seq: seq++,
        time: Date.now(),
        data: { space: structuredClone(space) },
      })
    }
    if (notice?.sessionId === sessionId) {
      events.push({
        type: 'user/message',
        seq: seq++,
        time: Date.now(),
        data: createReturnNoticeMessage(notice),
        surfaceOp: 'append',
      })
    }
    if (events.length > 0) await persistence.append(sessionId, events)
  }
}

function appendReturnNotice(session: Session, notice: ReturnNotice): void {
  session.append('user/message', createReturnNoticeMessage(notice), { surfaceOp: 'append' })
}

function createReturnNoticeMessage(notice: ReturnNotice) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `# Handoff returned from ${notice.branchTitle}\n\n${notice.handoff.trim()}`,
    }],
    source: {
      kind: 'plugin',
      plugin: RETURN_NOTICE_SOURCE,
      form: 'notice',
      summary: boundContextSummary(`Handoff returned from ${notice.branchTitle}`),
    },
  })
}

async function recoverIncompleteOperation(
  ctx: Context,
  writes: Map<string, Promise<void>>,
  sessionId: SessionId,
): Promise<void> {
  const initial = locateSpace(ctx, sessionId)
  if (initial?.node.status !== 'returning' && initial?.node.checkpointRefreshingAt === undefined) return
  await serializeWrite(writes, initial.space.rootSessionId, async () => {
    const located = locateSpace(ctx, sessionId)
    if (!located) return
    const active = located.node.status === 'returning'
      ? cancelReturnNode(located.space, located.node.id, Date.now())
      : located.node.checkpointRefreshingAt !== undefined
        ? cancelCheckpointNode(located.space, located.node.id, Date.now())
        : undefined
    if (!active) return
    await appendSpace(ctx, liveSessions(ctx, active), active)
  })
}

async function markBranchStarted(
  ctx: Context,
  writes: Map<string, Promise<void>>,
  sessionId: SessionId,
): Promise<void> {
  const initial = locateSpace(ctx, sessionId)
  if (!initial?.node.dormant) return
  await serializeWrite(writes, initial.space.rootSessionId, async () => {
    const located = locateSpace(ctx, sessionId)
    if (!located?.node.dormant) return
    const started = activateNode(located.space, located.node.id, Date.now())
    await appendSpace(ctx, liveSessions(ctx, started), started)
  })
}

async function createChildHandle(ctx: Context, parentAgent: Agent, childSessionId: SessionId): Promise<AgentHandle> {
  const handle = await ctx.agents.create({
    sessionId: childSessionId,
    agentOptions: parentAgent.options,
    meta: {
      ...(parentAgent.session.header.cwd ? { cwd: parentAgent.session.header.cwd } : {}),
      parentSession: parentAgent.session.id,
      ...(parentAgent.session.header.agentPreset ? { agentPreset: parentAgent.session.header.agentPreset } : {}),
    },
    setup: (childCtx) => {
      childCtx.get('agentPresets')?.composeFrom(childCtx, parentAgent.ctx)
    },
  })
  try {
    const workspace = ctx.workspaceRegistry.list().find(candidate => (
      candidate.sessionIds.includes(parentAgent.session.id)
    ))
    await workspace?.attachSession(childSessionId)
    return handle
  } catch (error) {
    await handle.dispose()
    throw error
  }
}

function success(message: string, space: ThinkingSpace, sessionId?: SessionId): ToolResult {
  return {
    ok: true,
    message,
    ...(sessionId ? { sessionId } : {}),
    revision: space.revision,
  }
}

async function serializeWrite<T>(
  writes: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  writes.set(key, tail)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (writes.get(key) === tail) writes.delete(key)
  }
}
