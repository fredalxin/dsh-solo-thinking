# DSH Solo Thinking architecture

## Goal and scope

This plugin extracts the semantic core of Solo Thinking mode into DeepSeek Harness (DSH): a rooted tree of isolated conversations, explicit cross-branch Handoffs, durable replay, and a visual branch map. It does not copy Solo's channel/team/database stack and it does not alter ordinary DSH conversations.

The implementation targets the public DSH `0.1.0-rc.6` contracts. The referenced AIGC Canvas repository currently has no published Git HEAD, so the DSH tutorial and the published DSH packages are the executable API reference.

## Product invariants

1. One Thinking node maps to one DSH Session. Parent and child never share raw messages.
2. Default suggestion mode uses one `thinking_suggest` call to create 2–4 initial root children (preferring four real directions) with Agent-authored targeted Handoffs. The batch is rejected once the root already has children and the children are never auto-run. Later autonomous splits use `thinking_split`; a human split creates a read-only `forkHandoffPending` child and asks the existing parent Agent to complete it through `thinking_fork_handoff`.
3. Cross-node context is limited to three semantic roles: inherited Handoff, current-state checkpoint, and terminal returned Handoff.
4. Human-requested Current State and Return are Agent control turns, not human-written summaries. Refresh temporarily records `checkpointRefreshingAt` and preserves the previous checkpoint on failure. Return locks a non-root node as `returning`; successful Return is terminal, while failure restores `active`.
5. An empty or running branch cannot begin Return, and a parent cannot return while any direct child is unreturned. Return never recursively wakes or returns the parent.
6. The ordinary DSH chat, history, tools, and sessions remain unchanged outside a Thinking space.

## Domain model

`ThinkingSpace` is the whole-value projection carried by `solo-thinking/state` Session events:

- `version`: persisted schema version, currently `1`.
- `revision`: monotonically increasing optimistic revision.
- `rootSessionId`: the DSH Session that created the space.
- `nodes`: flat, stable-order node array.

Each `ThinkingNode` owns:

- topology: `id`, `parentId`, `depth`, `sortOrder`;
- runtime identity: `sessionId`;
- presentation: `title`;
- handoffs: immutable `inheritedHandoff`, replaceable `checkpointHandoff`, terminal `returnedHandoff`;
- lifecycle: persisted child `dormant` until its first user message or Agent turn, `forkHandoffPending`, transient `checkpointRefreshingAt`, `active`, transient `returning`, or terminal `returned`, plus timestamps.

The state event is a whole-value replace, matching DSH's Session Projection contract. Pure transitions validate titles, depth, fan-out, Handoff size, returned-node sealing, and return eligibility before any runtime side effect.

## Ownership and lifecycle

The plugin owns child `AgentHandle`s, but creates them through the plugin's root Context rather than the parent Agent's scoped Context. `parentSession` remains durable topology metadata, while `origin: subagent` and runtime Agent ownership are deliberately absent. The branch is therefore an ordinary DSH Session that generic Host routing can open live or cold, while still receiving no parent event seed.

During the unpublished Agent setup window, `AgentPresets.composeFrom()` joins the child to the parent's exact standing preset composition. It inherits the caller's model options, workspace path, and tools without copying raw conversation history or adopting DSH's create-and-run subagent lifecycle.

The root is the caller's existing DSH Agent/Session and is not owned or disposed by the plugin. Human split creates the child first. If the parent has conversation, the child remains read-only while the parent control turn writes its targeted Handoff; an empty parent creates a ready child without manufacturing context. A failed fork remains pending and exposes Retry. `/thinking checkpoint` and `/thinking return` also accept no human Handoff. Their control commands keep the calling Agent alive through `whenIdle()`, which is required after a cold DSH resume, and verify the final Projection before reporting success. `turn/end` recovery clears failed checkpoint/return locks; a failed checkpoint preserves its prior value, while Return restores `active`.

Thinking mutations are exposed as model tools:

- `thinking_start`: create an idempotent space in the current Session.
- `thinking_suggest`: atomically materialize the root's initial 2–4 suggested directions; reject recursive or duplicate batches.
- `thinking_split`: create an empty child Session from an agent-authored child-specific Handoff.
- `thinking_fork_handoff`: complete the exact pending child requested by a human split.
- `thinking_checkpoint`: publish the current branch state for siblings.
- `thinking_return`: publish the final parent Handoff and seal the branch.
- `thinking_status`: read the current tree and branch state.

## Data flow and prompt context

Every node Session stores a replica of the latest whole `ThinkingSpace`. A mutation folds the highest visible revision containing the calling Session, computes one new state, appends it to every live Session, then uses the public Session persistence service to append the same event to cold node Sessions. Cold events are constructed at the stored log's exact next `seq`; they do not call `Session.fromRestore`, because that API inserts a runtime `session/end-seed` boundary and is not a cold append primitive. This gives each branch a local durable recovery copy and makes the same projection available while viewing any node after restarts.

Before each model request, a dynamic DSH system-prompt context locates the caller's node and renders:

- the immutable inherited Handoff;
- direct siblings' current-state or final Handoffs;
- direct children's final returned Handoffs;
- the Thinking lifecycle and tool rules.

No raw sibling or parent transcript is inspected or rendered. A successful return also appends one plugin-origin `user/message` notice containing the final Markdown Handoff to the parent Session. That notice is durable, surface-visible, and model-facing. Updating a checkpoint or returning a child does not wake another Agent; the parent consumes both the notice and updated dynamic context only on its next explicit turn.

## Persistence and recovery

DSH Session logs are the only persistence layer. `solo-thinking/state` events are non-surface control events, so they do not enter model conversation history. The optional `soloThinking` Session Projection folds the last whole-value event and supplies the web UI.

DSH `0.1.0-rc.6` exports a generated live `KNOWN_SESSION_EVENT_TYPES` set but does not yet expose the downstream event-registration service noted in its own source. The plugin registers `solo-thinking/state` in that set for its fiber lifetime, so JSONL/SQLite persistence accepts and reloads the required event. This isolated compatibility bridge must be replaced with the official registry as soon as DSH publishes one; no other runtime internals are patched.

On ordinary resume, the selected node restores its last replicated tree locally. When several live replicas are available, the highest `revision` wins and the next successful mutation re-converges online and cold replicas. The implementation assumes one DSH host process; cross-process concurrent writers are outside this first release.

Because DSH `0.1.0-rc.6` does not expose an atomic multi-Session append, a process crash between replica appends can leave a stale inactive replica. Reopening the root or any newer branch before mutating recovers the newer revision. A later DSH transaction/persistence service can replace replication without changing the event or projection schema.

## Frontend

The client plugin adds a `Thinking` entry to `conversation.view`. It reads `soloThinking` through the standard `useProjection` hook and renders a center-out orbit map:

- blue: active branches;
- amber: active branches with a published checkpoint;
- teal: children waiting for their parent-authored inherited Handoff;
- violet: branches whose Agent is refreshing Current State;
- indigo: branches whose Agent is preparing the final Return;
- gray: returned branches;
- selecting a node only changes the map selection; an explicit action opens its DSH Session through the existing Session service.

The selected branch shows its semantic context and Handoffs beside the graph. Node selection is local to the Thinking view and never changes the current DSH Session. A separate explicit action opens an already-started branch conversation; for a blank active branch, the panel first accepts the user's initial prompt, admits it to that child Session, and only then navigates. Conversation rendering remains DSH's existing Chat view; the plugin is an additive topology/context view, not a replacement chat implementation.

The selected node also exposes direct human controls. The Web client executes `/thinking` through the standard DSH Session command plane. Rename is a direct state edit. Split asks only for a title; fork inheritance, Current State refresh, and Return each run a constrained Agent turn with no human Handoff field. Pending fork nodes stay read-only and expose Retry. The selected node's loaded message count and running pulse are client-side activity cues; a short-height media layout compresses the orbit map so the host's fixed composer cannot cover node centers.

## Failure behavior

- Invalid or stale mutations fail before a state event is appended.
- If child Agent creation fails, no topology event is written.
- If state persistence fails after child creation, the newly created child handle is disposed.
- A failed parent fork-Handoff turn preserves the pending child for explicit retry.
- A failed Current State refresh preserves the last successful checkpoint and clears its refresh lock.
- Returned nodes reject further Thinking mutations. The model context also marks them read-only.
- Returning nodes reject split, rename, and checkpoint; a finalization turn that does not successfully return is automatically unlocked at `turn/end`.
- A child runtime is not automatically woken on split, checkpoint, or a sibling update.
- Missing optional Session Projection or web services leaves the host tools usable in a headless profile.

## Compatibility and migration

The plugin is additive and namespaced: package `dsh-plugin-solo-thinking`, events `solo-thinking/*`, projection `soloThinking`, and tools `thinking_*`. It requires the public DSH RC peer APIs but bundles only its own host/client code. Existing Sessions without `solo-thinking/state` fold to no space and behave exactly as before.

`ThinkingSpace.version` is the migration gate. A future incompatible state change must add an explicit pure upgrader before increasing the version; silently interpreting an unknown version is forbidden. Removing the plugin leaves ordinary Session history readable, while its unknown non-surface events are inert until the plugin is reinstalled.

## Verification boundary

This repository verifies pure state transitions, projection folding, prompt-context isolation, TypeScript contracts against the real public DSH packages, production bundling, and a repeatable Web E2E through DSH's adapter, Agent loop, RPC, JSONL persistence, Projection, and browser module loader. The controlled Provider drives deterministic tool calls without an external key; real-model tool-selection quality remains a separate Provider-backed acceptance test.
