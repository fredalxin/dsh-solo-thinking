import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { KNOWN_SESSION_EVENT_TYPES, SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z as z$1 } from "zod";
//#region src/domain.ts
const THINKING_STATE_EVENT = "solo-thinking/state";
const THINKING_PROJECTION = "soloThinking";
const DEFAULT_LIMITS = {
	maxDepth: 4,
	maxBranches: 6,
	maxNodes: 40,
	maxHandoffChars: 8e3
};
const DEFAULT_SUGGESTED_BRANCH_COUNT = 4;
const nodeSchema = z$1.object({
	id: z$1.string().min(1),
	sessionId: z$1.string().min(1),
	parentId: z$1.string().min(1).nullable(),
	title: z$1.string().min(1),
	depth: z$1.number().int().nonnegative(),
	sortOrder: z$1.number().int().nonnegative(),
	status: z$1.enum([
		"active",
		"returning",
		"returned"
	]),
	dormant: z$1.boolean().optional(),
	forkHandoffPending: z$1.boolean().optional(),
	inheritedHandoff: z$1.string().optional(),
	checkpointHandoff: z$1.string().optional(),
	returnedHandoff: z$1.string().optional(),
	createdAt: z$1.number().int().nonnegative(),
	updatedAt: z$1.number().int().nonnegative(),
	forkHandoffRequestedAt: z$1.number().int().nonnegative().optional(),
	checkpointRefreshingAt: z$1.number().int().nonnegative().optional(),
	checkpointAt: z$1.number().int().nonnegative().optional(),
	returningAt: z$1.number().int().nonnegative().optional(),
	returnedAt: z$1.number().int().nonnegative().optional()
});
const thinkingSpaceSchema = z$1.object({
	version: z$1.literal(1),
	revision: z$1.number().int().nonnegative(),
	rootSessionId: z$1.string().min(1),
	nodes: z$1.array(nodeSchema).min(1)
});
function createSpace(rootSessionId, rootTitle, now) {
	return {
		version: 1,
		revision: 0,
		rootSessionId,
		nodes: [{
			id: rootSessionId,
			sessionId: rootSessionId,
			parentId: null,
			title: normalizeTitle(rootTitle),
			depth: 0,
			sortOrder: 0,
			status: "active",
			createdAt: now,
			updatedAt: now
		}]
	};
}
function foldThinkingSpace(events) {
	let state = null;
	for (const event of events) if (event.type === "solo-thinking/state") state = thinkingSpaceSchema.parse(event.data.space);
	return state;
}
function nodeForSession(space, sessionId) {
	return space.nodes.find((node) => node.sessionId === sessionId);
}
function nodeById(space, nodeId) {
	const node = space.nodes.find((candidate) => candidate.id === nodeId);
	if (!node) throw new Error(`Thinking node "${nodeId}" does not exist`);
	return node;
}
function splitNode(space, parentId, child, limits, now) {
	return addChildNode(space, parentId, child, { inheritedHandoff: normalizeHandoff(child.inheritedHandoff, limits.maxHandoffChars) }, limits, now);
}
function suggestNodes(space, parentId, children, limits, now) {
	requireActive(space, parentId);
	if (parentId !== space.rootSessionId) throw new Error("Automatic suggestions are only available for the initial root fan-out");
	if (children.length < 2 || children.length > 4) throw new Error(`Automatic suggestions require 2–4 directions`);
	if (space.nodes.some((node) => node.parentId === parentId)) throw new Error("Automatic suggestions are only available before this branch has children");
	return children.reduce((current, child) => splitNode(current, parentId, child, limits, now), space);
}
function requestSplitNode(space, parentId, child, requiresHandoff, limits, now) {
	return addChildNode(space, parentId, child, requiresHandoff ? {
		forkHandoffPending: true,
		forkHandoffRequestedAt: now
	} : {}, limits, now);
}
function activateNode(space, nodeId, now) {
	const node = nodeById(space, nodeId);
	if (!node.dormant) return space;
	const { dormant: _dormant, ...startedNode } = node;
	return replaceNode(space, node.id, {
		...startedNode,
		updatedAt: now
	});
}
function retrySplitHandoffNode(space, parentId, childId, now) {
	requireActive(space, parentId);
	const child = nodeById(space, childId);
	if (child.parentId !== parentId || !child.forkHandoffPending) throw new Error("Thinking child is not waiting for this parent Handoff");
	return replaceNode(space, child.id, {
		...child,
		forkHandoffRequestedAt: now,
		updatedAt: now
	});
}
function completeSplitHandoff(space, parentId, childId, handoff, limits, now) {
	requireActive(space, parentId);
	const child = nodeById(space, childId);
	if (child.parentId !== parentId || !child.forkHandoffPending) throw new Error("Thinking child is not waiting for this parent Handoff");
	const inheritedHandoff = normalizeHandoff(handoff, limits.maxHandoffChars);
	const { forkHandoffRequestedAt: _requestedAt, ...stableChild } = child;
	return replaceNode(space, child.id, {
		...stableChild,
		forkHandoffPending: false,
		inheritedHandoff,
		updatedAt: now
	});
}
function addChildNode(space, parentId, child, handoffState, limits, now) {
	const parent = requireActive(space, parentId);
	if (parent.depth >= limits.maxDepth) throw new Error(`Thinking depth limit (${limits.maxDepth}) reached`);
	if (space.nodes.length >= limits.maxNodes) throw new Error(`Thinking node limit (${limits.maxNodes}) reached`);
	const siblings = space.nodes.filter((node) => node.parentId === parent.id);
	if (siblings.length >= limits.maxBranches) throw new Error(`Branch limit (${limits.maxBranches}) reached for this node`);
	const title = normalizeTitle(child.title);
	if (siblings.some((node) => node.title.toLocaleLowerCase() === title.toLocaleLowerCase())) throw new Error(`A sibling branch named "${title}" already exists`);
	if (space.nodes.some((node) => node.id === child.id || node.sessionId === child.sessionId)) throw new Error("Thinking child identity already exists");
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
			status: "active",
			dormant: true,
			...handoffState,
			createdAt: now,
			updatedAt: now
		}]
	};
}
function checkpointNode(space, nodeId, handoff, limits, now) {
	const node = requireActive(space, nodeId, true);
	const checkpointHandoff = normalizeHandoff(handoff, limits.maxHandoffChars);
	const { checkpointRefreshingAt: _refreshingAt, ...stableNode } = node;
	return replaceNode(space, node.id, {
		...stableNode,
		checkpointHandoff,
		checkpointAt: now,
		updatedAt: now
	});
}
function beginCheckpointNode(space, nodeId, now) {
	const node = requireActive(space, nodeId);
	if (node.checkpointRefreshingAt !== void 0) throw new Error(`Thinking branch "${node.title}" is already refreshing Current State`);
	return replaceNode(space, node.id, {
		...node,
		checkpointRefreshingAt: now,
		updatedAt: now
	});
}
function cancelCheckpointNode(space, nodeId, now) {
	const node = nodeById(space, nodeId);
	if (node.checkpointRefreshingAt === void 0) throw new Error(`Thinking branch "${node.title}" is not refreshing Current State`);
	const { checkpointRefreshingAt: _refreshingAt, ...activeNode } = node;
	return replaceNode(space, node.id, {
		...activeNode,
		updatedAt: now
	});
}
function renameNode(space, nodeId, title, now) {
	const node = requireActive(space, nodeId);
	return replaceNode(space, node.id, {
		...node,
		title: normalizeTitle(title),
		updatedAt: now
	});
}
function returnNode(space, nodeId, handoff, limits, now) {
	const node = requireReturnable(space, nodeId);
	assertReturnTopology(space, node);
	const returnedHandoff = normalizeHandoff(handoff, limits.maxHandoffChars);
	const { returningAt: _returningAt, ...stableNode } = node;
	return replaceNode(space, node.id, {
		...stableNode,
		status: "returned",
		returnedHandoff,
		updatedAt: now,
		returnedAt: now
	});
}
function beginReturnNode(space, nodeId, now) {
	const node = requireActive(space, nodeId);
	assertReturnTopology(space, node);
	return replaceNode(space, node.id, {
		...node,
		status: "returning",
		returningAt: now,
		updatedAt: now
	});
}
function cancelReturnNode(space, nodeId, now) {
	const node = nodeById(space, nodeId);
	if (node.status !== "returning") throw new Error(`Thinking branch "${node.title}" is not preparing a return`);
	const { returningAt: _returningAt, ...activeNode } = node;
	return replaceNode(space, node.id, {
		...activeNode,
		status: "active",
		updatedAt: now
	});
}
function renderBranchContext(space, nodeId) {
	const node = nodeById(space, nodeId);
	const parent = node.parentId === null ? void 0 : nodeById(space, node.parentId);
	const siblings = space.nodes.filter((candidate) => candidate.parentId === node.parentId && candidate.id !== node.id);
	const returnedChildren = space.nodes.filter((candidate) => candidate.parentId === node.id && candidate.status === "returned");
	const lines = [
		"# Solo Thinking branch",
		`Current branch: ${node.title} (${node.status})`,
		parent ? `Parent branch: ${parent.title}` : "This is the root branch.",
		"",
		"Raw conversations are isolated by DSH Session. Never infer or request another branch's raw transcript.",
		"Default suggested-direction mode is ON for the root branch. When the root has no children and enough context exists, identify 2–4 genuinely independent high-value directions (prefer exactly 4) and create them together with thinking_suggest before asking the user which direction to enter.",
		"Never merely present a numbered list of future directions: if you show multiple next directions, the matching child nodes must already exist. Do not split when the user explicitly asks to stay linear, or when fewer than two genuinely independent directions exist. Suggested branches are created dormant and must not be auto-run.",
		"After the initial root batch, use thinking_split for any later one-off child branch. Do not recursively fan every suggested child into another automatic batch.",
		"After the first meaningful reply, publish an outward Current State with thinking_checkpoint. Update it only when cross-branch-relevant objectives, conclusions, evidence, risks, dependencies, unresolved work, or next action materially change.",
		"Use thinking_split only with a child-specific Handoff. Use thinking_return only when this non-root branch is ready to seal."
	];
	if (node.status === "returned") lines.push("", "This branch has returned and is read-only for Thinking mutations.");
	else if (node.status === "returning") lines.push("", "This branch is preparing its final parent Handoff. Call thinking_return with the final Markdown transfer; do not continue ordinary branch work.");
	else if (node.forkHandoffPending) lines.push("", "This branch is waiting for its parent-authored fork Handoff and cannot start yet.");
	if (node.inheritedHandoff) lines.push("", "## From parent", node.inheritedHandoff);
	lines.push("", "## Related branches");
	if (siblings.length === 0) lines.push("No sibling branch has been created.");
	else for (const sibling of siblings) {
		const state = sibling.returnedHandoff ?? sibling.checkpointHandoff;
		const label = sibling.status === "returned" ? "final" : sibling.forkHandoffPending ? "preparing inherited context" : "current state";
		lines.push(`### ${sibling.title} — ${label}`, state ?? "No state published.");
	}
	if (returnedChildren.length > 0) {
		lines.push("", "## Returned children");
		for (const child of returnedChildren) lines.push(`### ${child.title}`, child.returnedHandoff ?? "No final Handoff recorded.");
	}
	return lines.join("\n");
}
function replaceNode(space, id, replacement) {
	return {
		...space,
		revision: space.revision + 1,
		nodes: space.nodes.map((node) => node.id === id ? replacement : node)
	};
}
function requireActive(space, nodeId, allowCheckpointRefresh = false) {
	const node = nodeById(space, nodeId);
	if (node.status !== "active") throw new Error(`Thinking branch "${node.title}" ${node.status === "returning" ? "is preparing a return" : "has returned"}`);
	if (node.forkHandoffPending) throw new Error(`Thinking branch "${node.title}" is preparing inherited context`);
	if (!allowCheckpointRefresh && node.checkpointRefreshingAt !== void 0) throw new Error(`Thinking branch "${node.title}" is refreshing Current State`);
	return node;
}
function requireReturnable(space, nodeId) {
	const node = nodeById(space, nodeId);
	if (node.status === "returned") throw new Error(`Thinking branch "${node.title}" has returned`);
	if (node.forkHandoffPending) throw new Error(`Thinking branch "${node.title}" is preparing inherited context`);
	if (node.checkpointRefreshingAt !== void 0) throw new Error(`Thinking branch "${node.title}" is refreshing Current State`);
	return node;
}
function assertReturnTopology(space, node) {
	if (node.parentId === null) throw new Error("The root Thinking node cannot return");
	const activeChild = space.nodes.find((candidate) => candidate.parentId === node.id && candidate.status !== "returned");
	if (activeChild) throw new Error(`Return blocked: child branch "${activeChild.title}" is still active`);
}
function normalizeTitle(value) {
	const title = value.trim().replace(/\s+/g, " ");
	if (!title) throw new Error("Thinking branch title cannot be blank");
	if (title.length > 80) throw new Error("Thinking branch title must be at most 80 characters");
	return title;
}
function normalizeHandoff(value, maxChars) {
	const handoff = value.trim();
	if (!handoff) throw new Error("Thinking Handoff cannot be blank");
	if (handoff.length > maxChars) throw new Error(`Thinking Handoff must be at most ${maxChars} characters`);
	return handoff;
}
//#endregion
//#region src/rc-event-catalog.ts
/**
* DSH 0.1.0-rc.6 generates a closed persistence vocabulary and exposes no
* downstream registration service yet. Register this plugin's required event
* in the exported live catalog until DSH adds that service.
*/
function installRcEventCatalogEntry(runtime) {
	const register = runtime?.registerEventType;
	if (register) return register.call(runtime, THINKING_STATE_EVENT);
	const catalog = KNOWN_SESSION_EVENT_TYPES;
	const alreadyKnown = catalog.has(THINKING_STATE_EVENT);
	catalog.add(THINKING_STATE_EVENT);
	return () => {
		if (!alreadyKnown) catalog.delete(THINKING_STATE_EVENT);
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-plugin-solo-thinking";
const inject = [
	"agents",
	"sessions",
	"systemPrompt",
	"tools",
	"workspaceRegistry"
];
const RETURN_REQUEST_MARKER = "[solo-thinking:return-request]";
const SPLIT_REQUEST_MARKER = "[solo-thinking:split-request]";
const CHECKPOINT_REQUEST_MARKER = "[solo-thinking:checkpoint-request]";
const CONTROL_NOTICE_SOURCE = "dsh-plugin-solo-thinking:control";
const RETURN_NOTICE_SOURCE = "dsh-plugin-solo-thinking:return";
const Config = z.object({
	rootTitle: z.string().default("Brainstorm"),
	maxDepth: z.natural().min(1).default(DEFAULT_LIMITS.maxDepth),
	maxBranches: z.natural().min(1).default(DEFAULT_LIMITS.maxBranches),
	maxNodes: z.natural().min(2).default(DEFAULT_LIMITS.maxNodes),
	maxHandoffChars: z.natural().min(200).default(DEFAULT_LIMITS.maxHandoffChars)
});
const resultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: {
			type: "boolean",
			const: true,
			required: true
		},
		message: {
			type: "string",
			required: true
		},
		sessionId: { type: "string" },
		revision: {
			type: "integer",
			required: true
		}
	}
};
function apply(ctx, rawConfig = {}) {
	const config = resolveConfig(rawConfig);
	const handles = /* @__PURE__ */ new Map();
	const writes = /* @__PURE__ */ new Map();
	ctx.effect(() => installRcEventCatalogEntry(ctx.sessions), "solo-thinking: DSH RC event catalog");
	ctx.effect(() => async () => {
		const owned = [...handles.values()];
		handles.clear();
		await Promise.allSettled(owned.map((handle) => handle.dispose()));
	}, "solo-thinking: child agents");
	const startThinking = async (agent, title) => serializeWrite(writes, agent.session.id, async () => {
		const existing = locateSpace(ctx, agent.session.id);
		if (existing) return success(`Thinking is already active at "${existing.node.title}".`, existing.space);
		const space = createSpace(agent.session.id, title ?? config.rootTitle, Date.now());
		await appendSpace(ctx, [agent.session], space);
		return success("Thinking started. Default suggestion mode is on: create the initial 2–4 directions with thinking_suggest once enough context exists.", space);
	});
	const splitThinking = async (parentAgent, title, handoff) => {
		const initial = requireSpace(ctx, parentAgent);
		return serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, parentAgent);
			const childId = `thinking-${globalThis.crypto.randomUUID()}`;
			const childSessionId = SessionId(childId);
			const next = splitNode(located.space, located.node.id, {
				id: childId,
				sessionId: childSessionId,
				title,
				inheritedHandoff: handoff
			}, config, Date.now());
			const handle = await createChildHandle(ctx, parentAgent, childSessionId);
			try {
				await appendSpace(ctx, liveSessions(ctx, next), next);
				handles.set(childSessionId, handle);
			} catch (error) {
				await handle.dispose();
				throw error;
			}
			return success(`Created isolated branch "${title}". It is ready for you or the Agent to open.`, next, childSessionId);
		});
	};
	const suggestThinking = async (parentAgent, directions) => {
		const initial = requireSpace(ctx, parentAgent);
		return serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, parentAgent);
			const branches = directions.map((direction) => {
				const id = `thinking-${globalThis.crypto.randomUUID()}`;
				return {
					id,
					sessionId: SessionId(id),
					title: direction.title,
					inheritedHandoff: direction.handoff
				};
			});
			const next = suggestNodes(located.space, located.node.id, branches, config, Date.now());
			const created = [];
			try {
				for (const branch of branches) created.push({
					sessionId: branch.sessionId,
					handle: await createChildHandle(ctx, parentAgent, branch.sessionId)
				});
				await appendSpace(ctx, liveSessions(ctx, next), next);
				for (const child of created) handles.set(child.sessionId, child.handle);
			} catch (error) {
				await Promise.allSettled(created.map(({ handle }) => handle.dispose()));
				throw error;
			}
			return success(`Created ${branches.length} suggested branches: ${branches.map(({ title }) => `"${title.trim()}"`).join(", ")}. They remain dormant until explicitly opened.`, next);
		});
	};
	const requestSplitThinking = async (parentAgent, title) => {
		const initial = requireSpace(ctx, parentAgent);
		const prepared = await serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, parentAgent);
			if (parentAgent.status !== "idle") throw new Error("Split blocked: this branch Agent is still running");
			const childId = `thinking-${globalThis.crypto.randomUUID()}`;
			const childSessionId = SessionId(childId);
			const requiresHandoff = hasConversation(parentAgent.session);
			const next = requestSplitNode(located.space, located.node.id, {
				id: childId,
				sessionId: childSessionId,
				title
			}, requiresHandoff, config, Date.now());
			const handle = await createChildHandle(ctx, parentAgent, childSessionId);
			try {
				await appendSpace(ctx, liveSessions(ctx, next), next);
				handles.set(childSessionId, handle);
			} catch (error) {
				await handle.dispose();
				throw error;
			}
			if (requiresHandoff) {
				parentAgent.followup(createControlMessage(renderSplitRequest(childId, title), `Prepare inherited Handoff for ${title}`));
				return {
					childId,
					childSessionId,
					requiresHandoff,
					space: next
				};
			}
			return {
				childId,
				childSessionId,
				requiresHandoff,
				space: next
			};
		});
		if (!prepared.requiresHandoff) return success(`Created ready branch "${title}" without manufactured context because its parent is empty.`, prepared.space, prepared.childSessionId);
		await parentAgent.whenIdle();
		const completed = requireSpace(ctx, parentAgent);
		const child = nodeById(completed.space, prepared.childId);
		if (child.forkHandoffPending) throw new Error(`Inherited Handoff failed for "${child.title}". The pending branch is preserved; select it to retry.`);
		return success(`Created "${child.title}" with an Agent-authored inherited Handoff.`, completed.space, prepared.childSessionId);
	};
	const retrySplitHandoffThinking = async (parentAgent, childId) => {
		const initial = requireSpace(ctx, parentAgent);
		const prepared = await serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, parentAgent);
			if (parentAgent.status !== "idle") throw new Error("Split retry blocked: the parent Agent is still running");
			const child = nodeById(located.space, childId);
			const next = retrySplitHandoffNode(located.space, located.node.id, childId, Date.now());
			await appendSpace(ctx, liveSessions(ctx, next), next);
			parentAgent.followup(createControlMessage(renderSplitRequest(child.id, child.title), `Retry inherited Handoff for ${child.title}`));
			return {
				childSessionId: SessionId(child.sessionId),
				space: next
			};
		});
		await parentAgent.whenIdle();
		const completed = requireSpace(ctx, parentAgent);
		const child = nodeById(completed.space, childId);
		if (child.forkHandoffPending) throw new Error(`Inherited Handoff failed again for "${child.title}". The branch remains pending.`);
		return success(`Inherited Handoff is ready for "${child.title}".`, completed.space, prepared.childSessionId);
	};
	const completeSplitHandoffThinking = async (parentAgent, childId, handoff) => {
		const initial = requireSpace(ctx, parentAgent);
		return serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, parentAgent);
			const child = nodeById(located.space, childId);
			const next = completeSplitHandoff(located.space, located.node.id, childId, handoff, config, Date.now());
			await appendSpace(ctx, liveSessions(ctx, next), next);
			return success(`Inherited Handoff prepared for "${child.title}".`, next, SessionId(child.sessionId));
		});
	};
	const checkpointThinking = async (agent, handoff) => {
		const initial = requireSpace(ctx, agent);
		return serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, agent);
			const next = checkpointNode(located.space, located.node.id, handoff, config, Date.now());
			await appendSpace(ctx, liveSessions(ctx, next), next);
			return success(`Published Current State for "${located.node.title}".`, next);
		});
	};
	const requestCheckpointThinking = async (agent) => {
		const initial = requireSpace(ctx, agent);
		const refreshingAt = await serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, agent);
			if (agent.status !== "idle") throw new Error("Current State refresh blocked: this branch Agent is still running");
			if (!hasConversation(agent.session)) throw new Error("Current State refresh blocked: this branch has no conversation to summarize");
			const refreshing = beginCheckpointNode(located.space, located.node.id, Date.now());
			await appendSpace(ctx, liveSessions(ctx, refreshing), refreshing);
			try {
				agent.followup(createControlMessage(renderCheckpointRequest(located.node.title), `Refresh Current State for ${located.node.title}`));
			} catch (error) {
				const active = cancelCheckpointNode(refreshing, located.node.id, Date.now());
				await appendSpace(ctx, liveSessions(ctx, active), active);
				throw error;
			}
			return refreshing.nodes.find((node) => node.id === located.node.id).checkpointRefreshingAt;
		});
		await agent.whenIdle();
		const completed = requireSpace(ctx, agent);
		if (completed.node.checkpointAt === void 0 || completed.node.checkpointAt < refreshingAt) throw new Error(`Current State refresh failed for "${completed.node.title}". The previous Current State was preserved.`);
		return success(`Agent refreshed Current State for "${completed.node.title}".`, completed.space);
	};
	const renameThinking = async (agent, title) => {
		const initial = requireSpace(ctx, agent);
		return serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, agent);
			const next = renameNode(located.space, located.node.id, title, Date.now());
			await appendSpace(ctx, liveSessions(ctx, next), next);
			return success(`Renamed branch to "${title.trim()}".`, next);
		});
	};
	const requestReturnThinking = async (agent) => {
		const initial = requireSpace(ctx, agent);
		await serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, agent);
			if (agent.status !== "idle") throw new Error("Return blocked: this branch Agent is still running");
			if (!hasConversation(agent.session)) throw new Error("Return blocked: this branch has no conversation to summarize");
			const returning = beginReturnNode(located.space, located.node.id, Date.now());
			await appendSpace(ctx, liveSessions(ctx, returning), returning);
			try {
				agent.followup(createControlMessage(renderReturnRequest(located.node.title), `Prepare final Handoff for ${located.node.title}`, RETURN_NOTICE_SOURCE));
			} catch (error) {
				const active = cancelReturnNode(returning, located.node.id, Date.now());
				await appendSpace(ctx, liveSessions(ctx, active), active);
				throw error;
			}
			return returning;
		});
		await agent.whenIdle();
		const completed = requireSpace(ctx, agent);
		if (completed.node.status !== "returned") throw new Error(`Final Handoff failed for "${completed.node.title}". The branch was restored and can be retried.`);
		return success(`Returned "${completed.node.title}" to its parent and sealed the branch.`, completed.space);
	};
	const returnThinking = async (agent, handoff) => {
		const initial = requireSpace(ctx, agent);
		return serializeWrite(writes, initial.space.rootSessionId, async () => {
			const located = requireSpace(ctx, agent);
			const next = returnNode(located.space, located.node.id, handoff, config, Date.now());
			const parent = nodeById(next, located.node.parentId);
			await appendSpace(ctx, liveSessions(ctx, next), next, {
				sessionId: parent.sessionId,
				branchTitle: located.node.title,
				handoff
			});
			const handle = handles.get(agent.session.id);
			if (handle) {
				handles.delete(agent.session.id);
				agent.whenIdle().then(() => handle.dispose()).catch(() => void 0);
			}
			return success(`Returned "${located.node.title}" to its parent and sealed the branch.`, next);
		});
	};
	ctx.inject(["sessionProjections"], (projectionCtx) => projectionCtx.sessionProjections.register({
		key: THINKING_PROJECTION,
		schema: thinkingSpaceSchema.nullable(),
		init: () => null,
		apply: (state, event) => event.type === "solo-thinking/state" ? event.data.space : state,
		view: (state) => state,
		stateVersion: 1
	}));
	ctx.systemPrompt.context({
		name: "solo-thinking:branch-context",
		order: 50,
		text: (assembly) => {
			const agent = assembly.agent;
			if (!agent) return "";
			const located = locateSpace(ctx, agent.session.id);
			return located ? renderBranchContext(located.space, located.node.id) : "";
		}
	});
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		const located = locateSpace(ctx, agent.session.id);
		if (located?.node.status === "returned" || located?.node.forkHandoffPending) return { kind: "reject" };
		return next();
	});
	ctx.on("session/event", (session, event) => {
		if (event.type === "turn/start" || event.type === "user/message" && event.data.source.kind === "user") queueMicrotask(() => {
			markBranchStarted(ctx, writes, session.id).catch((error) => {
				ctx.logger.warn(`solo-thinking: failed to mark branch started: ${renderError(error)}`);
			});
		});
		if (event.type === "turn/end") queueMicrotask(() => {
			recoverIncompleteOperation(ctx, writes, session.id).catch((error) => {
				ctx.logger.warn(`solo-thinking: failed to recover transient state: ${renderError(error)}`);
			});
		});
	});
	ctx.tools.register(defineTool({
		name: "thinking_start",
		description: "Start or read a Solo Thinking brainstorm space in the current DSH Session.",
		parameters: { title: {
			type: "string",
			description: "Short title for the root brainstorm branch. Omit to use the configured default."
		} },
		output: outputContract("Start result"),
		execute: async (args, exec) => {
			const agent = requireAgent(exec);
			return startThinking(agent, args.title);
		}
	}));
	ctx.tools.register(defineTool({
		name: "thinking_fork_handoff",
		description: "Complete a human-requested child split with the parent Agent's targeted inherited Handoff. Only the exact pending child may be completed.",
		parameters: {
			childId: {
				type: "string",
				required: true,
				description: "Exact pending child node id from the split request."
			},
			handoff: {
				type: "string",
				required: true,
				description: "Child-specific Markdown Handoff: objective/scope, confirmed conclusions, evidence/artifacts, unresolved questions, risks/assumptions, and recommended first action."
			}
		},
		output: outputContract("Fork Handoff result"),
		execute: async (args, exec) => {
			const parentAgent = requireAgent(exec);
			const result = await completeSplitHandoffThinking(parentAgent, args.childId, args.handoff);
			exec.concludeTurn();
			return result;
		}
	}));
	ctx.tools.register(defineTool({
		name: "thinking_suggest",
		description: "Default initial fan-out: create 2–4 (prefer exactly 4) genuinely distinct suggested child branches in one call. Use this before presenting multiple next directions; the branches stay dormant until explicitly opened.",
		parameters: { directions: {
			type: "array",
			required: true,
			description: "Two to four high-value, non-overlapping directions. Prefer exactly four; never add filler just to reach four.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					title: {
						type: "string",
						required: true,
						description: "Concise child branch title."
					},
					handoff: {
						type: "string",
						required: true,
						description: "Child-specific Markdown Handoff: objective/scope, confirmed context, evidence, risks, open questions, and recommended first action."
					}
				}
			}
		} },
		output: outputContract("Suggested branches result"),
		execute: async (args, exec) => {
			const parentAgent = requireAgent(exec);
			return suggestThinking(parentAgent, args.directions);
		}
	}));
	ctx.tools.register(defineTool({
		name: "thinking_split",
		description: "Create an isolated child DSH Session. The handoff must be a branch-specific, agent-authored Markdown transfer; raw history is never copied.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Concise child branch title."
			},
			handoff: {
				type: "string",
				required: true,
				description: "Markdown Handoff: objective/scope, confirmed context, evidence, risks, open questions, and recommended next action."
			}
		},
		output: outputContract("Split result"),
		execute: async (args, exec) => {
			const parentAgent = requireAgent(exec);
			return splitThinking(parentAgent, args.title, args.handoff);
		}
	}));
	ctx.tools.register(defineTool({
		name: "thinking_checkpoint",
		description: "Publish this active branch's latest cross-branch Current State without waking siblings.",
		parameters: { handoff: {
			type: "string",
			required: true,
			description: "Markdown Current State containing only cross-branch-relevant conclusions, evidence, risks, dependencies, and next action."
		} },
		output: outputContract("Checkpoint result"),
		execute: async (args, exec) => {
			const agent = requireAgent(exec);
			const requestedRefresh = requireSpace(ctx, agent).node.checkpointRefreshingAt !== void 0;
			const result = await checkpointThinking(agent, args.handoff);
			if (requestedRefresh) exec.concludeTurn();
			return result;
		}
	}));
	ctx.tools.register(defineTool({
		name: "thinking_return",
		description: "Return a final Handoff to the parent and terminally seal this non-root branch. All direct children must already be returned.",
		parameters: { handoff: {
			type: "string",
			required: true,
			description: "Final Markdown Handoff to the parent: conclusions, evidence/artifacts, unresolved risks, and recommended next action."
		} },
		output: outputContract("Return result"),
		execute: async (args, exec) => {
			const agent = requireAgent(exec);
			const result = await returnThinking(agent, args.handoff);
			exec.concludeTurn();
			return result;
		}
	}));
	ctx.tools.register(defineTool({
		name: "thinking_status",
		description: "Read the current Solo Thinking tree and this Session's branch lifecycle.",
		parameters: {},
		output: outputContract("Status result"),
		execute: async (_args, exec) => {
			const located = requireSpace(ctx, requireAgent(exec));
			const active = located.space.nodes.filter((node) => node.status === "active").length;
			const returning = located.space.nodes.filter((node) => node.status === "returning").length;
			const returned = located.space.nodes.filter((node) => node.status === "returned").length;
			return success(`Branch "${located.node.title}" is ${located.node.status}. Tree: ${active} active, ${returning} returning, ${returned} returned, ${located.space.nodes.length} total.`, located.space);
		}
	}));
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "thinking",
			description: "Control the current Solo Thinking tree",
			input: { hint: "start|split|split-retry|rename|checkpoint|return|status" },
			recordInput: false,
			handler: async ({ agent, rawInput }) => {
				try {
					const command = parseThinkingCommand(rawInput);
					let result;
					switch (command.action) {
						case "start":
							result = await startThinking(agent, command.title);
							break;
						case "split":
							result = await requestSplitThinking(agent, command.title);
							break;
						case "split-retry":
							result = await retrySplitHandoffThinking(agent, command.childId);
							break;
						case "rename":
							result = await renameThinking(agent, command.title);
							break;
						case "checkpoint":
							result = await requestCheckpointThinking(agent);
							break;
						case "return":
							result = await requestReturnThinking(agent);
							break;
						case "status": {
							const located = requireSpace(ctx, agent);
							const active = located.space.nodes.filter((node) => node.status === "active").length;
							const returning = located.space.nodes.filter((node) => node.status === "returning").length;
							const returned = located.space.nodes.filter((node) => node.status === "returned").length;
							result = success(`Branch "${located.node.title}" is ${located.node.status}. Tree: ${active} active, ${returning} returning, ${returned} returned, ${located.space.nodes.length} total.`, located.space);
							break;
						}
					}
					return {
						kind: "success",
						text: `${result.message} Revision ${result.revision}.`
					};
				} catch (error) {
					return {
						kind: "error",
						text: renderError(error)
					};
				}
			}
		});
	});
}
function parseThinkingCommand(rawInput) {
	const input = rawInput.trim();
	const separator = input.indexOf(" ");
	const action = separator === -1 ? input : input.slice(0, separator);
	const rawPayload = separator === -1 ? "" : input.slice(separator + 1).trim();
	if (action === "status") return { action };
	if (action === "return" && rawPayload === "") return { action };
	if (action === "checkpoint" && rawPayload === "") return { action };
	if (action === "start" && rawPayload === "") return { action };
	let payload;
	try {
		payload = JSON.parse(rawPayload);
	} catch {
		throw new Error("Invalid Thinking command payload");
	}
	if (!payload || typeof payload !== "object") throw new Error("Invalid Thinking command payload");
	const record = payload;
	if (action === "start" || action === "rename") {
		if (typeof record.title !== "string") throw new Error("Thinking command requires a title");
		return {
			action,
			title: record.title
		};
	}
	if (action === "split") {
		if (typeof record.title !== "string") throw new Error("Thinking split requires a title");
		return {
			action,
			title: record.title
		};
	}
	if (action === "split-retry") {
		if (typeof record.childId !== "string") throw new Error("Thinking split retry requires a child id");
		return {
			action,
			childId: record.childId
		};
	}
	throw new Error("Use /thinking start, split, split-retry, rename, checkpoint, return, or status");
}
function renderError(error) {
	return error instanceof Error ? error.message : String(error);
}
function renderReturnRequest(title) {
	return [
		RETURN_REQUEST_MARKER,
		`You are closing the Solo Thinking branch "${title}".`,
		"Review this branch conversation and call thinking_return exactly once with a concise final Markdown Handoff.",
		"Include conclusions, evidence or artifacts, unresolved risks, and the recommended next action for the parent branch.",
		"Do not continue ordinary branch work and do not give a normal final answer instead of calling the tool."
	].join("\n\n");
}
function renderSplitRequest(childId, title) {
	return [
		SPLIT_REQUEST_MARKER,
		`Prepare the initial Handoff for the newly split child branch "${title}".`,
		`The exact pending child id is: ${childId}`,
		"Use the full context already present in this exact parent Agent Session. Do not continue ordinary work.",
		"Call thinking_fork_handoff exactly once with that childId and concise Markdown using these headings:",
		"# Handoff",
		"## Objective and scope",
		"## Confirmed conclusions",
		"## Evidence or artifacts",
		"## Unresolved questions",
		"## Risks and assumptions",
		"## Recommended first action"
	].join("\n\n");
}
function renderCheckpointRequest(title) {
	return [
		CHECKPOINT_REQUEST_MARKER,
		`Publish a fresh Current State for the Solo Thinking branch "${title}".`,
		"Use the full context already present in this exact Agent Session. Do not continue ordinary work and do not write a normal reply.",
		"Call thinking_checkpoint exactly once with concise Markdown using these headings:",
		"# Handoff",
		"## Objective and scope",
		"## Confirmed conclusions",
		"## Evidence or artifacts",
		"## Unresolved questions",
		"## Risks and assumptions",
		"## Recommended next action"
	].join("\n\n");
}
function createControlMessage(text, summary, plugin = CONTROL_NOTICE_SOURCE) {
	return createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: {
			kind: "plugin",
			plugin,
			form: "notice",
			summary: boundContextSummary(summary)
		}
	});
}
function hasConversation(session) {
	return session.events.some((event) => event.type === "assistant/message" || event.type === "user/message" && event.data.source.kind === "user");
}
function outputContract(label) {
	return {
		schema: resultSchema,
		render: (_args, value) => [{
			type: "text",
			text: `${label}: ${value.message}\nRevision: ${value.revision}${value.sessionId ? `\nSession: ${value.sessionId}` : ""}`
		}]
	};
}
function resolveConfig(config) {
	return {
		rootTitle: config.rootTitle ?? "Brainstorm",
		maxDepth: config.maxDepth ?? DEFAULT_LIMITS.maxDepth,
		maxBranches: config.maxBranches ?? DEFAULT_LIMITS.maxBranches,
		maxNodes: config.maxNodes ?? DEFAULT_LIMITS.maxNodes,
		maxHandoffChars: config.maxHandoffChars ?? DEFAULT_LIMITS.maxHandoffChars
	};
}
function requireAgent(exec) {
	if (!exec.agent) throw new Error(`${exec.name} requires a calling DSH Agent`);
	return exec.agent;
}
function requireSpace(ctx, agent) {
	const located = locateSpace(ctx, agent.session.id);
	if (!located) throw new Error("No Thinking space is active in this Session; call thinking_start first");
	return located;
}
function locateSpace(ctx, sessionId) {
	let selected;
	for (const session of ctx.sessions.list()) {
		const space = foldThinkingSpace(session.events);
		if (!space) continue;
		const node = nodeForSession(space, sessionId);
		if (!node) continue;
		if (!selected || space.revision > selected.space.revision) selected = {
			space,
			node
		};
	}
	return selected;
}
function liveSessions(ctx, space) {
	const ids = new Set(space.nodes.map((node) => node.sessionId));
	return ctx.sessions.list().filter((session) => ids.has(session.id));
}
async function appendSpace(ctx, sessions, space, notice) {
	const live = new Map(sessions.map((session) => [session.id, session]));
	for (const session of sessions) {
		if (foldThinkingSpace(session.events)?.revision !== space.revision) session.append(THINKING_STATE_EVENT, { space });
		if (notice?.sessionId === session.id) appendReturnNotice(session, notice);
	}
	const persistence = ctx.get("sessionPersistence");
	if (!persistence) return;
	for (const node of space.nodes) {
		const sessionId = SessionId(node.sessionId);
		if (live.has(sessionId)) continue;
		const stored = await persistence.load(sessionId);
		const events = [];
		let seq = stored.events.length;
		if (foldThinkingSpace(stored.events)?.revision !== space.revision) events.push({
			type: THINKING_STATE_EVENT,
			seq: seq++,
			time: Date.now(),
			data: { space: structuredClone(space) }
		});
		if (notice?.sessionId === sessionId) events.push({
			type: "user/message",
			seq: seq++,
			time: Date.now(),
			data: createReturnNoticeMessage(notice),
			surfaceOp: "append"
		});
		if (events.length > 0) await persistence.append(sessionId, events);
	}
}
function appendReturnNotice(session, notice) {
	session.append("user/message", createReturnNoticeMessage(notice), { surfaceOp: "append" });
}
function createReturnNoticeMessage(notice) {
	return createUserMessage({
		content: [{
			type: "text",
			text: `# Handoff returned from ${notice.branchTitle}\n\n${notice.handoff.trim()}`
		}],
		source: {
			kind: "plugin",
			plugin: RETURN_NOTICE_SOURCE,
			form: "notice",
			summary: boundContextSummary(`Handoff returned from ${notice.branchTitle}`)
		}
	});
}
async function recoverIncompleteOperation(ctx, writes, sessionId) {
	const initial = locateSpace(ctx, sessionId);
	if (initial?.node.status !== "returning" && initial?.node.checkpointRefreshingAt === void 0) return;
	await serializeWrite(writes, initial.space.rootSessionId, async () => {
		const located = locateSpace(ctx, sessionId);
		if (!located) return;
		const active = located.node.status === "returning" ? cancelReturnNode(located.space, located.node.id, Date.now()) : located.node.checkpointRefreshingAt !== void 0 ? cancelCheckpointNode(located.space, located.node.id, Date.now()) : void 0;
		if (!active) return;
		await appendSpace(ctx, liveSessions(ctx, active), active);
	});
}
async function markBranchStarted(ctx, writes, sessionId) {
	const initial = locateSpace(ctx, sessionId);
	if (!initial?.node.dormant) return;
	await serializeWrite(writes, initial.space.rootSessionId, async () => {
		const located = locateSpace(ctx, sessionId);
		if (!located?.node.dormant) return;
		const started = activateNode(located.space, located.node.id, Date.now());
		await appendSpace(ctx, liveSessions(ctx, started), started);
	});
}
async function createChildHandle(ctx, parentAgent, childSessionId) {
	const handle = await ctx.agents.create({
		sessionId: childSessionId,
		agentOptions: parentAgent.options,
		meta: {
			...parentAgent.session.header.cwd ? { cwd: parentAgent.session.header.cwd } : {},
			parentSession: parentAgent.session.id,
			...parentAgent.session.header.agentPreset ? { agentPreset: parentAgent.session.header.agentPreset } : {}
		},
		setup: (childCtx) => {
			childCtx.get("agentPresets")?.composeFrom(childCtx, parentAgent.ctx);
		}
	});
	try {
		await ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(parentAgent.session.id))?.attachSession(childSessionId);
		return handle;
	} catch (error) {
		await handle.dispose();
		throw error;
	}
}
function success(message, space, sessionId) {
	return {
		ok: true,
		message,
		...sessionId ? { sessionId } : {},
		revision: space.revision
	};
}
async function serializeWrite(writes, key, task) {
	const previous = writes.get(key) ?? Promise.resolve();
	let release = () => {};
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	writes.set(key, tail);
	await previous;
	try {
		return await task();
	} finally {
		release();
		if (writes.get(key) === tail) writes.delete(key);
	}
}
//#endregion
export { Config, DEFAULT_LIMITS, DEFAULT_SUGGESTED_BRANCH_COUNT, THINKING_PROJECTION, THINKING_STATE_EVENT, activateNode, apply, beginCheckpointNode, beginReturnNode, cancelCheckpointNode, cancelReturnNode, checkpointNode, completeSplitHandoff, createSpace, foldThinkingSpace, inject, installRcEventCatalogEntry, name, nodeById, nodeForSession, renameNode, renderBranchContext, requestSplitNode, retrySplitHandoffNode, returnNode, splitNode, suggestNodes, thinkingSpaceSchema };

//# sourceMappingURL=index.js.map