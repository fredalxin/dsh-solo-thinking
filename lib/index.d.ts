import { SessionEvent } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { Context } from "@deepseek-ai/cordis";
//#region src/domain.d.ts
declare const THINKING_STATE_EVENT: "solo-thinking/state";
declare const THINKING_PROJECTION: "soloThinking";
type ThinkingNodeStatus = 'active' | 'returning' | 'returned';
interface ThinkingNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  title: string;
  depth: number;
  sortOrder: number;
  status: ThinkingNodeStatus;
  dormant?: boolean | undefined;
  forkHandoffPending?: boolean | undefined;
  inheritedHandoff?: string | undefined;
  checkpointHandoff?: string | undefined;
  returnedHandoff?: string | undefined;
  createdAt: number;
  updatedAt: number;
  forkHandoffRequestedAt?: number | undefined;
  checkpointRefreshingAt?: number | undefined;
  checkpointAt?: number | undefined;
  returningAt?: number | undefined;
  returnedAt?: number | undefined;
}
interface ThinkingSpace {
  version: 1;
  revision: number;
  rootSessionId: string;
  nodes: ThinkingNode[];
}
interface ThinkingLimits {
  maxDepth: number;
  maxBranches: number;
  maxNodes: number;
  maxHandoffChars: number;
}
declare const DEFAULT_LIMITS: ThinkingLimits;
declare const DEFAULT_SUGGESTED_BRANCH_COUNT = 4;
declare const thinkingSpaceSchema: z$1.ZodType<ThinkingSpace>;
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'solo-thinking/state': {
      space: ThinkingSpace;
    };
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    soloThinking: ThinkingSpace | null;
  }
}
declare function createSpace(rootSessionId: string, rootTitle: string, now: number): ThinkingSpace;
declare function foldThinkingSpace(events: readonly SessionEvent[]): ThinkingSpace | null;
declare function nodeForSession(space: ThinkingSpace, sessionId: string): ThinkingNode | undefined;
declare function nodeById(space: ThinkingSpace, nodeId: string): ThinkingNode;
declare function splitNode(space: ThinkingSpace, parentId: string, child: {
  id: string;
  sessionId: string;
  title: string;
  inheritedHandoff: string;
}, limits: ThinkingLimits, now: number): ThinkingSpace;
declare function suggestNodes(space: ThinkingSpace, parentId: string, children: readonly {
  id: string;
  sessionId: string;
  title: string;
  inheritedHandoff: string;
}[], limits: ThinkingLimits, now: number): ThinkingSpace;
declare function requestSplitNode(space: ThinkingSpace, parentId: string, child: {
  id: string;
  sessionId: string;
  title: string;
}, requiresHandoff: boolean, limits: ThinkingLimits, now: number): ThinkingSpace;
declare function activateNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace;
declare function retrySplitHandoffNode(space: ThinkingSpace, parentId: string, childId: string, now: number): ThinkingSpace;
declare function completeSplitHandoff(space: ThinkingSpace, parentId: string, childId: string, handoff: string, limits: ThinkingLimits, now: number): ThinkingSpace;
declare function checkpointNode(space: ThinkingSpace, nodeId: string, handoff: string, limits: ThinkingLimits, now: number): ThinkingSpace;
declare function beginCheckpointNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace;
declare function cancelCheckpointNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace;
declare function renameNode(space: ThinkingSpace, nodeId: string, title: string, now: number): ThinkingSpace;
declare function returnNode(space: ThinkingSpace, nodeId: string, handoff: string, limits: ThinkingLimits, now: number): ThinkingSpace;
declare function beginReturnNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace;
declare function cancelReturnNode(space: ThinkingSpace, nodeId: string, now: number): ThinkingSpace;
declare function renderBranchContext(space: ThinkingSpace, nodeId: string): string;
//#endregion
//#region src/rc-event-catalog.d.ts
/**
 * DSH 0.1.0-rc.6 generates a closed persistence vocabulary and exposes no
 * downstream registration service yet. Register this plugin's required event
 * in the exported live catalog until DSH adds that service.
 */
declare function installRcEventCatalogEntry(runtime?: unknown): () => void;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-plugin-solo-thinking";
declare const inject: string[];
interface Config extends Partial<ThinkingLimits> {
  rootTitle?: string;
}
declare const Config: z<Schemastery.ObjectS<{
  rootTitle: z<string, string>;
  maxDepth: z<number, number>;
  maxBranches: z<number, number>;
  maxNodes: z<number, number>;
  maxHandoffChars: z<number, number>;
}>, Schemastery.ObjectT<{
  rootTitle: z<string, string>;
  maxDepth: z<number, number>;
  maxBranches: z<number, number>;
  maxNodes: z<number, number>;
  maxHandoffChars: z<number, number>;
}>>;
declare function apply(ctx: Context, rawConfig?: Config): void;
//#endregion
export { Config, DEFAULT_LIMITS, DEFAULT_SUGGESTED_BRANCH_COUNT, THINKING_PROJECTION, THINKING_STATE_EVENT, ThinkingLimits, ThinkingNode, ThinkingNodeStatus, ThinkingSpace, activateNode, apply, beginCheckpointNode, beginReturnNode, cancelCheckpointNode, cancelReturnNode, checkpointNode, completeSplitHandoff, createSpace, foldThinkingSpace, inject, installRcEventCatalogEntry, name, nodeById, nodeForSession, renameNode, renderBranchContext, requestSplitNode, retrySplitHandoffNode, returnNode, splitNode, suggestNodes, thinkingSpaceSchema };
//# sourceMappingURL=index.d.ts.map