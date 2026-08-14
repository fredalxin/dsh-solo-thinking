import type { ThinkingNode, ThinkingSpace } from '../domain.js'

export interface OrbitPoint {
  node: ThinkingNode
  x: number
  y: number
}

export interface OrbitLayout {
  width: number
  height: number
  points: OrbitPoint[]
}

export function computeOrbitLayout(space: ThinkingSpace, width = 900, height = 640): OrbitLayout {
  const root = space.nodes.find((node) => node.parentId === null)
  if (!root) return { width, height, points: [] }

  const children = new Map<string, ThinkingNode[]>()
  for (const node of space.nodes) {
    if (node.parentId === null) continue
    const group = children.get(node.parentId) ?? []
    group.push(node)
    children.set(node.parentId, group)
  }
  for (const group of children.values()) group.sort((a, b) => a.sortOrder - b.sortOrder)

  const leafOrder: ThinkingNode[] = []
  const collectLeaves = (node: ThinkingNode) => {
    const group = children.get(node.id) ?? []
    if (group.length === 0) {
      leafOrder.push(node)
      return
    }
    for (const child of group) collectLeaves(child)
  }
  collectLeaves(root)
  if (leafOrder.length === 0) leafOrder.push(root)

  const angle = new Map<string, number>()
  for (const [index, leaf] of leafOrder.entries()) {
    angle.set(leaf.id, -Math.PI / 2 + (index * Math.PI * 2) / leafOrder.length)
  }

  const resolveAngle = (node: ThinkingNode): number => {
    const existing = angle.get(node.id)
    if (existing !== undefined) return existing
    const group = children.get(node.id) ?? []
    const values = group.map(resolveAngle)
    const x = values.reduce((sum, value) => sum + Math.cos(value), 0)
    const y = values.reduce((sum, value) => sum + Math.sin(value), 0)
    const value = Math.atan2(y, x)
    angle.set(node.id, value)
    return value
  }
  resolveAngle(root)

  const maxDepth = Math.max(...space.nodes.map((node) => node.depth), 1)
  const ring = Math.min((Math.min(width, height) - 180) / (maxDepth * 2), 150)
  const centerX = width / 2
  const centerY = height / 2
  return {
    width,
    height,
    points: space.nodes.map((node) => {
      const radius = node.depth * ring
      const theta = angle.get(node.id) ?? 0
      return {
        node,
        x: centerX + Math.cos(theta) * radius,
        y: centerY + Math.sin(theta) * radius,
      }
    }),
  }
}
