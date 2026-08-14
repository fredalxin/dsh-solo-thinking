window.__ModuleLoader__.load({ id: "dsh-plugin-solo-thinking", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
import { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
//#region src/client/index.d.ts
declare const inject: string[];
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
}
interface ThinkingRailToggleProps extends PropsRuntime<'conversation.session.header.actions'> {
  openDetails: () => void;
}
interface ThinkingRailInputToggleProps extends PropsRuntime<'conversation.input.right'> {
  openDetails: () => void;
}
declare function apply(ctx: ClientContext): void;
declare function ThinkingView({ sessionId, useProjection, useSession, useSessions, openSession, sendToBranch, runCommand }: ThinkingViewProps): import("react").JSX.Element;
declare function ThinkingRailToggle({ useProjection, openDetails }: ThinkingRailToggleProps): import("react").JSX.Element | null;
declare function ThinkingRailInputToggle({ useProjection, useSession, openDetails }: ThinkingRailInputToggleProps): import("react").JSX.Element | null;
declare function ThinkingRail({ sessionId, useProjection, useSessions, openSession, sendToBranch, runCommand, openDetails }: ThinkingRailProps): import("react").JSX.Element | null;
//#endregion
export { ThinkingRail, ThinkingRailInputToggle, ThinkingRailToggle, ThinkingView, apply, inject };
return module.exports; } });
//# sourceMappingURL=client.d.ts.map