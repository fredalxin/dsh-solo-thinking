import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThinkingNode, ThinkingSpace } from '../src/domain.js'
import {
  activateConversationView,
  apply,
  BETTER_SIDEBAR_TAB_ID,
  shouldOpenNodeConversation,
  ThinkingRail,
  ThinkingView,
} from '../src/client/index.js'

describe('Better Sidebar integration', () => {
  it('registers one optional single-instance thinking-tree tab', () => {
    const registerTab = vi.fn(() => vi.fn())
    const openTab = vi.fn()
    const slotsInject = vi.fn()
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ current: undefined, byId: {} }),
          subscribe: () => vi.fn(),
        },
      },
      layout: { openDetails: vi.fn() },
      slots: { inject: slotsInject },
      betterSidebar: { registerTab, openTab },
      effect: vi.fn((factory: () => unknown) => factory()),
      inject: vi.fn((_services: string[], activate: (scope: ClientContext) => void) => activate(ctx as unknown as ClientContext)),
    }

    apply(ctx as unknown as ClientContext)

    expect(slotsInject).toHaveBeenCalledWith('conversation.view', expect.any(Function))
    expect(registerTab).toHaveBeenCalledOnce()
    expect(registerTab).toHaveBeenCalledWith(expect.objectContaining({
      id: BETTER_SIDEBAR_TAB_ID,
      title: '头脑风暴',
      order: 30,
      single: true,
      component: expect.any(Function),
    }))
    expect(openTab).not.toHaveBeenCalled()
  })

  it('prewarms every branch sidebar and focuses the current session last', () => {
    const openTab = vi.fn()
    const projection = {
      getSnapshot: () => ({
        rootSessionId: 'auto-session',
        nodes: [
          { id: 'root', sessionId: 'auto-session' },
          { id: 'child', sessionId: 'child-session' },
        ],
      }),
      subscribe: () => vi.fn(),
    }
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({
            current: 'auto-session',
            byId: {
              'auto-session': { cwd: '/workspace' },
              'child-session': { cwd: '/workspace' },
            },
          }),
          subscribe: () => vi.fn(),
        },
        binding: () => ({ session: { projections: { faceOf: () => projection } } }),
      },
      layout: { openDetails: vi.fn() },
      slots: { inject: vi.fn() },
      betterSidebar: { registerTab: vi.fn(() => vi.fn()), openTab },
      effect: vi.fn((factory: () => unknown) => factory()),
      inject: vi.fn((_services: string[], activate: (scope: ClientContext) => void) => activate(ctx as unknown as ClientContext)),
    }

    apply(ctx as unknown as ClientContext)

    expect(openTab).toHaveBeenCalledTimes(2)
    expect(openTab).toHaveBeenNthCalledWith(
      1,
      { type: BETTER_SIDEBAR_TAB_ID },
      { sessionId: 'child-session', cwd: '/workspace' },
    )
    expect(openTab).toHaveBeenLastCalledWith(
      { type: BETTER_SIDEBAR_TAB_ID },
      { sessionId: 'auto-session', cwd: '/workspace' },
    )
  })

  it('unwinds the optional service integration and registers again after provider replacement', () => {
    const disposeList = vi.fn()
    const disposeProjection = vi.fn()
    const projection = {
      getSnapshot: () => ({
        rootSessionId: 'replacement-root',
        nodes: [{ id: 'root', sessionId: 'replacement-root' }],
      }),
      subscribe: vi.fn(() => disposeProjection),
    }
    const sessions = {
      list: {
        getSnapshot: () => ({ current: 'replacement-root', byId: { 'replacement-root': { cwd: '/workspace' } } }),
        subscribe: vi.fn(() => disposeList),
      },
      binding: () => ({ session: { projections: { faceOf: () => projection } } }),
    }
    let activateSidebar: ((scope: ClientContext) => void) | undefined
    const base = {
      sessions,
      layout: { openDetails: vi.fn() },
      slots: { inject: vi.fn() },
      effect: vi.fn((factory: () => unknown) => factory()),
      inject: vi.fn((_services: string[], activate: (scope: ClientContext) => void) => {
        activateSidebar = activate
      }),
    }

    apply(base as unknown as ClientContext)

    const mount = () => {
      const disposeTab = vi.fn()
      const openTab = vi.fn()
      let cleanup: (() => void) | undefined
      const scope = {
        ...base,
        betterSidebar: { registerTab: vi.fn(() => disposeTab), openTab },
        effect: vi.fn((factory: () => unknown) => {
          const result = factory()
          if (typeof result === 'function') cleanup = result as () => void
        }),
      }
      activateSidebar?.(scope as unknown as ClientContext)
      return { cleanup, disposeTab, openTab }
    }

    const first = mount()
    expect(first.openTab).toHaveBeenCalledOnce()
    first.cleanup?.()
    expect(disposeList).toHaveBeenCalledOnce()
    expect(disposeProjection).toHaveBeenCalledOnce()
    expect(first.disposeTab).toHaveBeenCalledOnce()

    const replacement = mount()
    expect(replacement.openTab).toHaveBeenCalledOnce()
  })

  it('activates the central conversation tab without touching sidebar tabs', () => {
    const explorer = tab('Explorer')
    const thinking = tab('头脑风暴')
    const conversation = tab('对话', 'false')
    const root = {
      querySelectorAll: vi.fn(() => [explorer, thinking, conversation]),
    }

    expect(activateConversationView(root as unknown as ParentNode)).toBe(true)
    expect(conversation.click).toHaveBeenCalledOnce()
    expect(explorer.click).not.toHaveBeenCalled()
    expect(thinking.click).not.toHaveBeenCalled()
  })

  it('opens started nodes but keeps dormant nodes in the sidebar composer', () => {
    const started = node({ sessionId: 'branch-started', dormant: false })
    const dormant = node({ sessionId: 'branch-dormant', dormant: true })
    const preparing = node({ sessionId: 'branch-preparing', dormant: false, forkHandoffPending: true })

    expect(shouldOpenNodeConversation(started, 'root', { blank: false })).toBe(true)
    expect(shouldOpenNodeConversation(started, 'branch-started', { blank: false })).toBe(false)
    expect(shouldOpenNodeConversation(dormant, 'root', { blank: true })).toBe(false)
    expect(shouldOpenNodeConversation(preparing, 'root', { blank: false })).toBe(false)
  })

  it('renders the sidebar legend and all four Markdown context surfaces', () => {
    const markdown = '# Handoff\n\n## Confirmed conclusions\n\n- **Evidence** is ready.'
    const space: ThinkingSpace = {
      version: 1,
      revision: 4,
      rootSessionId: 'root-session',
      nodes: [
        node({ id: 'root', sessionId: 'root-session', parentId: null, depth: 0, sortOrder: 0, title: '主方向' }),
        node({ id: 'selected', sessionId: 'selected-session', parentId: 'root', sortOrder: 0, title: '当前分支', inheritedHandoff: markdown, checkpointHandoff: markdown }),
        node({ id: 'sibling', sessionId: 'sibling-session', parentId: 'root', sortOrder: 1, title: '兄弟分支', checkpointHandoff: markdown }),
        node({ id: 'child', sessionId: 'child-session', parentId: 'selected', depth: 2, sortOrder: 0, title: '子分支', status: 'returned', returnedHandoff: markdown }),
      ],
    }
    const sessionSnapshot = {
      byId: {
        'selected-session': { blank: false, running: false },
        'sibling-session': { blank: false, running: false },
        'child-session': { blank: false, running: false },
      },
    }
    const props = {
      sessionId: 'selected-session',
      useProjection: () => space,
      useSessions: (selector: (snapshot: typeof sessionSnapshot) => unknown) => selector(sessionSnapshot),
      openSession: vi.fn(),
      sendToBranch: vi.fn(),
      runCommand: vi.fn(),
      openDetails: vi.fn(),
      autoOpen: false,
    } as unknown as Parameters<typeof ThinkingRail>[0]

    const html = renderToStaticMarkup(createElement(ThinkingRail, props))

    expect(html).toContain('节点状态图例')
    expect(html).toContain('父节点结论')
    expect(html).toContain('当前结论')
    expect(html).toContain('兄弟感知')
    expect(html).toContain('子节点结论')
    expect(html).toContain('从 当前分支 新建分支')
    expect(html.match(/<details/g)).toHaveLength(4)
    expect(html).not.toMatch(/<details[^>]* open/)
    expect(html).toContain('flex: 1 1 420px')
    expect(html).toContain('<h1>Handoff</h1>')
    expect(html).toContain('<strong>Evidence</strong> is ready.')
    expect(html).not.toContain('# Handoff')
  })

  it('renders parent, current, sibling, and child conclusions in the full fallback tab', () => {
    const markdown = '# Handoff\n\n- **Evidence** is ready.'
    const space: ThinkingSpace = {
      version: 1,
      revision: 5,
      rootSessionId: 'root-session',
      nodes: [
        node({ id: 'root', sessionId: 'root-session', parentId: null, depth: 0, sortOrder: 0, title: '主方向' }),
        node({ id: 'selected', sessionId: 'selected-session', parentId: 'root', sortOrder: 0, title: '当前分支', inheritedHandoff: markdown, checkpointHandoff: markdown }),
        node({ id: 'sibling', sessionId: 'sibling-session', parentId: 'root', sortOrder: 1, title: '兄弟分支', checkpointHandoff: markdown }),
        node({ id: 'child', sessionId: 'child-session', parentId: 'selected', depth: 2, sortOrder: 0, title: '子分支', status: 'returned', returnedHandoff: markdown }),
      ],
    }
    const sessionSnapshot = {
      byId: {
        'selected-session': { blank: false, running: false },
        'sibling-session': { blank: false, running: false },
        'child-session': { blank: false, running: false },
      },
    }
    const sessionFace = { nodes: [], turnEnds: new Set<string>() }
    const props = {
      sessionId: 'selected-session',
      useProjection: () => space,
      useSession: (selector: (snapshot: typeof sessionFace) => unknown) => selector(sessionFace),
      useSessions: (selector: (snapshot: typeof sessionSnapshot) => unknown) => selector(sessionSnapshot),
      openSession: vi.fn(),
      sendToBranch: vi.fn(),
      runCommand: vi.fn(),
    } as unknown as Parameters<typeof ThinkingView>[0]

    const html = renderToStaticMarkup(createElement(ThinkingView, props))

    expect(html).toContain('父节点结论')
    expect(html).toContain('当前结论')
    expect(html).toContain('兄弟感知')
    expect(html).toContain('子节点结论')
    expect(html).toContain('兄弟分支')
    expect(html).toContain('子分支')
    expect(html).toContain('1/1 已发布')
    expect(html).toContain('1/1 已回传')
    expect(html).toContain('<h1>Handoff</h1>')
  })
})

function tab(label: string, selected = 'false') {
  return {
    textContent: label,
    getAttribute: vi.fn((name: string) => name === 'aria-selected' ? selected : null),
    click: vi.fn(),
  }
}

function node(fields: Partial<ThinkingNode>): ThinkingNode {
  return {
    id: 'node',
    sessionId: 'branch',
    title: '分支',
    depth: 1,
    sortOrder: 0,
    parentId: 'root',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  } as ThinkingNode
}
