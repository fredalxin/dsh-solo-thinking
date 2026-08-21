window.__ModuleLoader__.load({ id: "dsh-plugin-solo-thinking", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
import { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import "zod";
import "@deepseek-ai/dsh-session";
//#region src/domain.d.ts
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
  endedAt?: number | undefined;
  nodes: ThinkingNode[];
}
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
//#endregion
//#region src/client/index.d.ts
declare const inject: string[];
declare const BETTER_SIDEBAR_TAB_ID = "dsh-plugin-solo-thinking:tree";
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.details.aux': {
      kind: 'list';
      scope: 'session';
    };
  }
}
interface BranchActions {
  openSession: (sessionId: string) => void;
  sendToBranch: (sessionId: string, prompt: string) => Promise<void>;
  runCommand: (sessionId: string, line: string) => Promise<void>;
}
interface ThinkingViewProps extends ConvViewProps, BranchActions {}
interface ThinkingRailProps extends PropsRuntime<'conversation.details.aux'>, BranchActions {
  openDetails: () => void;
  autoOpen?: boolean;
}
interface ThinkingRailToggleProps extends PropsRuntime<'conversation.session.header.actions'> {
  openDetails: () => void;
}
interface ThinkingRailInputToggleProps extends PropsRuntime<'conversation.input.right'> {
  openDetails: () => void;
}
declare function apply(ctx: ClientContext): void;
declare function activateConversationView(root?: ParentNode): boolean;
declare function shouldOpenNodeConversation(node: ThinkingNode, currentSessionId: string, state?: {
  blank?: boolean;
}): boolean;
declare function ThinkingView({ sessionId, useProjection, useSession, useSessions, openSession, sendToBranch, runCommand }: ThinkingViewProps): import("react").JSX.Element;
declare function ThinkingRailToggle({ useProjection, openDetails }: ThinkingRailToggleProps): import("react").JSX.Element | null;
declare function ThinkingRailInputToggle({ useProjection, useSession, openDetails }: ThinkingRailInputToggleProps): import("react").JSX.Element | null;
declare function ThinkingRail({ sessionId, useProjection, useSessions, openSession, sendToBranch, runCommand, openDetails, autoOpen }: ThinkingRailProps): import("react").JSX.Element | null;
//#endregion
export { BETTER_SIDEBAR_TAB_ID, ThinkingRail, ThinkingRailInputToggle, ThinkingRailToggle, ThinkingView, activateConversationView, apply, inject, shouldOpenNodeConversation };
return module.exports; } });
//# sourceMappingURL=client.d.ts.map