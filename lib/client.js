window.__ModuleLoader__.load({ id: "dsh-plugin-solo-thinking", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/layout.ts
function computeOrbitLayout(space, width = 900, height = 640) {
	const root = space.nodes.find((node) => node.parentId === null);
	if (!root) return {
		width,
		height,
		points: []
	};
	const children = /* @__PURE__ */ new Map();
	for (const node of space.nodes) {
		if (node.parentId === null) continue;
		const group = children.get(node.parentId) ?? [];
		group.push(node);
		children.set(node.parentId, group);
	}
	for (const group of children.values()) group.sort((a, b) => a.sortOrder - b.sortOrder);
	const leafOrder = [];
	const collectLeaves = (node) => {
		const group = children.get(node.id) ?? [];
		if (group.length === 0) {
			leafOrder.push(node);
			return;
		}
		for (const child of group) collectLeaves(child);
	};
	collectLeaves(root);
	if (leafOrder.length === 0) leafOrder.push(root);
	const angle = /* @__PURE__ */ new Map();
	for (const [index, leaf] of leafOrder.entries()) angle.set(leaf.id, -Math.PI / 2 + index * Math.PI * 2 / leafOrder.length);
	const resolveAngle = (node) => {
		const existing = angle.get(node.id);
		if (existing !== void 0) return existing;
		const values = (children.get(node.id) ?? []).map(resolveAngle);
		const x = values.reduce((sum, value) => sum + Math.cos(value), 0);
		const y = values.reduce((sum, value) => sum + Math.sin(value), 0);
		const value = Math.atan2(y, x);
		angle.set(node.id, value);
		return value;
	};
	resolveAngle(root);
	const maxDepth = Math.max(...space.nodes.map((node) => node.depth), 1);
	const ring = Math.min((Math.min(width, height) - 180) / (maxDepth * 2), 150);
	const centerX = width / 2;
	const centerY = height / 2;
	return {
		width,
		height,
		points: space.nodes.map((node) => {
			const radius = node.depth * ring;
			const theta = angle.get(node.id) ?? 0;
			return {
				node,
				x: centerX + Math.cos(theta) * radius,
				y: centerY + Math.sin(theta) * radius
			};
		})
	};
}
//#endregion
//#region src/client/index.tsx
const inject = [
	"slots",
	"sessions",
	"layout"
];
const autoOpenedSessions = /* @__PURE__ */ new Set();
function apply(ctx) {
	const sessions = ctx.sessions;
	const openDetails = () => ctx.layout.openDetails();
	const branchActions = () => ({
		openSession: (sessionId) => sessions.open(sessionId),
		sendToBranch: async (sessionId, prompt) => {
			const session = sessions.binding(sessionId)?.session;
			if (!session) throw new Error("当前分支尚未连接，请刷新后再试。");
			const result = await session.prompt([{
				type: "text",
				text: prompt
			}], "queue");
			if (!result.ok) throw new Error(result.error.message);
		},
		runCommand: async (sessionId, line) => {
			const session = sessions.binding(sessionId)?.session;
			if (!session) throw new Error("当前分支尚未连接，请刷新后再试。");
			const result = await session.command(line);
			if (!result.ok) throw new Error(result.error.message);
			if (!result.value.matched) throw new Error("DSH 尚未加载 /thinking 控制命令，请重启 DSH。");
		}
	});
	ctx.slots.inject("conversation.view", () => ctx.slots.register({
		name: "conversation.view",
		id: "solo-thinking",
		order: 20,
		label: "头脑风暴",
		inject: branchActions
	}, ThinkingView));
	ctx.slots.inject("conversation.details.aux", function* () {
		yield ctx.slots.register({
			name: "conversation.details.aux",
			id: "solo-thinking",
			order: 0,
			inject: () => ({
				...branchActions(),
				openDetails
			})
		}, ThinkingRail);
		yield ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
			name: "conversation.session.header.actions",
			id: "solo-thinking-details",
			order: 5,
			inject: () => ({ openDetails })
		}, ThinkingRailToggle));
		yield ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
			name: "conversation.input.right",
			id: "solo-thinking-details",
			order: 5,
			inject: () => ({ openDetails })
		}, ThinkingRailInputToggle));
	});
}
function ThinkingView({ sessionId, useProjection, useSession, useSessions, openSession, sendToBranch, runCommand }) {
	const rootRef = (0, react.useRef)(null);
	const space = useProjection("soloThinking");
	const layout = (0, react.useMemo)(() => space ? computeOrbitLayout(space) : null, [space]);
	const current = space?.nodes.find((node) => node.sessionId === sessionId);
	const [selectedNodeId, setSelectedNodeId] = (0, react.useState)(null);
	const selected = space?.nodes.find((node) => node.id === selectedNodeId) ?? current;
	const selectedSessionId = selected?.sessionId ?? sessionId;
	const selectedParentSessionId = (selected?.parentId ? space?.nodes.find((node) => node.id === selected.parentId) : void 0)?.sessionId ?? sessionId;
	const sessionStates = useSessions((snapshot) => snapshot.byId);
	const selectedRunning = sessionStates[selectedSessionId]?.running ?? false;
	const selectedParentRunning = sessionStates[selectedParentSessionId]?.running ?? false;
	const selectedBlank = sessionStates[selectedSessionId]?.blank ?? false;
	const selectedDormant = selected?.dormant ?? selectedBlank;
	const messageCount = useSession((snapshot) => snapshot.nodes.reduce((count, node) => node.kind === "user" || node.kind === "assistant" ? count + 1 : count, 0));
	const turnCount = useSession((snapshot) => snapshot.turnEnds.size);
	const [action, setAction] = (0, react.useState)(null);
	const [title, setTitle] = (0, react.useState)("");
	const [submitting, setSubmitting] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const [kickoff, setKickoff] = (0, react.useState)("请开始处理这个分支，先说明你的思路，再继续执行。");
	const [starting, setStarting] = (0, react.useState)(false);
	const [startError, setStartError] = (0, react.useState)(null);
	const [retrying, setRetrying] = (0, react.useState)(false);
	(0, react.useEffect)(() => {
		let parent = rootRef.current?.parentElement;
		while (parent) {
			const { overflowY } = window.getComputedStyle(parent);
			if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) {
				parent.scrollTop = 0;
				break;
			}
			parent = parent.parentElement;
		}
	}, [sessionId]);
	if (!space || !layout || !selected) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("main", {
		ref: rootRef,
		className: "st-empty",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: styles }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "st-empty-mark",
				children: "◎"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "st-kicker",
				children: "SOLO THINKING"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "把一个问题，拆成彼此独立的思路。" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
				"在聊天里让 Agent 调用 ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "thinking_start" }),
				"。默认建议模式会优先把 4 个高价值方向直接建立为分支；每个分支拥有独立 DSH Session，只通过 Handoff 交换结论。"
			] })
		]
	});
	const points = new Map(layout.points.map((point) => [point.node.id, point]));
	const parent = selected.parentId ? space.nodes.find((node) => node.id === selected.parentId) : void 0;
	const siblings = space.nodes.filter((node) => node.parentId === selected.parentId && node.id !== selected.id);
	const children = space.nodes.filter((node) => node.parentId === selected.id);
	const isCurrentSession = selected.sessionId === sessionId;
	const selectNode = (node) => {
		setSelectedNodeId(node.id);
		setAction(null);
		setError(null);
		setStartError(null);
	};
	const beginAction = (next) => {
		setAction(next);
		setTitle(next === "rename" ? selected.title : "");
		setError(null);
	};
	const submitAction = async (event) => {
		event.preventDefault();
		if (!action) return;
		setSubmitting(true);
		setError(null);
		try {
			const line = action === "return" || action === "checkpoint" ? `/thinking ${action}` : `/thinking ${action} ${JSON.stringify({ title })}`;
			await runCommand(selected.sessionId, line);
			setAction(null);
			setTitle("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};
	const retrySelectedHandoff = async () => {
		if (!parent) return;
		setRetrying(true);
		setStartError(null);
		try {
			await runCommand(parent.sessionId, `/thinking split-retry ${JSON.stringify({ childId: selected.id })}`);
		} catch (cause) {
			setStartError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRetrying(false);
		}
	};
	const startSelectedBranch = async () => {
		const prompt = kickoff.trim();
		if (!prompt) return;
		setStarting(true);
		setStartError(null);
		try {
			await sendToBranch(selected.sessionId, prompt);
			setKickoff("");
			setStarting(false);
		} catch (cause) {
			setStartError(cause instanceof Error ? cause.message : String(cause));
			setStarting(false);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("main", {
		ref: rootRef,
		className: "st-shell",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: styles }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: "st-header",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "st-kicker",
					children: [
						"SOLO THINKING · REV ",
						space.revision,
						isCurrentSession ? ` · ${turnCount} 轮 / ${messageCount} 条对话` : " · 已选中分支"
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: selected.title })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `st-status st-status--${nodeTone(selected)}${selectedRunning || selected.forkHandoffPending && selectedParentRunning ? " is-running" : ""}`,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}), activityLabel(selected, selectedRunning, selectedParentRunning, selectedDormant)]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "st-workspace",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "st-map-panel",
					"aria-label": "Thinking branch map",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "st-map-legend",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Legend, {
									color: "#1677ff",
									label: "发散中"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Legend, {
									color: "#e7a62b",
									label: "已发布进展"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Legend, {
									color: "#138a9b",
									label: "继承准备中"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Legend, {
									color: "#5b6ee1",
									label: "回传中"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Legend, {
									color: "#8b95a5",
									label: "已完成"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "st-map-actions",
							"aria-label": "思考树操作",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => beginAction("split"),
									disabled: selected.status !== "active" || selected.forkHandoffPending || selected.checkpointRefreshingAt !== void 0 || selectedRunning,
									children: "＋ 新建分支"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => beginAction("rename"),
									disabled: selected.status !== "active" || selected.forkHandoffPending || selected.checkpointRefreshingAt !== void 0,
									children: "✎ 重命名"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									onClick: () => beginAction("checkpoint"),
									disabled: selected.status !== "active" || selected.forkHandoffPending || selected.checkpointRefreshingAt !== void 0 || selectedRunning || selectedDormant,
									children: ["● ", selected.checkpointHandoff ? "刷新进展" : "生成进展"]
								}),
								selected.parentId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => beginAction("return"),
									disabled: selected.status !== "active" || selected.forkHandoffPending || selected.checkpointRefreshingAt !== void 0 || selectedRunning || selectedDormant,
									children: "✓ 让 Agent 回传"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "st-map-canvas",
							style: { "--st-map-ratio": `${layout.width} / ${layout.height}` },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
								viewBox: `0 0 ${layout.width} ${layout.height}`,
								preserveAspectRatio: "none",
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("g", {
									className: "st-edges",
									children: layout.points.flatMap((point) => {
										if (!point.node.parentId) return [];
										const source = points.get(point.node.parentId);
										if (!source) return [];
										return [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
											x1: source.x,
											y1: source.y,
											x2: point.x,
											y2: point.y
										}, point.node.id)];
									})
								})
							}), layout.points.map((point) => {
								const isSelected = point.node.id === selected.id;
								const radius = point.node.depth === 0 ? 52 : 42;
								const pointState = sessionStates[point.node.sessionId];
								const pointDormant = point.node.dormant ?? pointState?.blank ?? false;
								const pointRunning = pointState?.running ?? false;
								const pointParent = point.node.parentId ? space.nodes.find((node) => node.id === point.node.parentId) : void 0;
								const pointParentRunning = pointParent ? sessionStates[pointParent.sessionId]?.running ?? false : false;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "st-node-anchor",
									style: {
										left: `${point.x / layout.width * 100}%`,
										top: `${point.y / layout.height * 100}%`
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: `st-node st-node--${nodeTone(point.node)}${isSelected ? " is-selected" : ""}${pointRunning || point.node.forkHandoffPending && pointParentRunning ? " is-running" : ""}`,
										style: { "--st-node-size": `${radius * 2}px` },
										"aria-label": `选择 ${point.node.title}`,
										onClick: () => selectNode(point.node),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "st-node-title",
												children: clip(point.node.title, 12)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "st-node-state",
												children: pointDormant && point.node.status === "active" && !point.node.forkHandoffPending ? "未启动" : statusLabel(point.node)
											}),
											isSelected && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "st-node-activity",
												children: nodeActivityLabel(selected, selectedRunning, selectedParentRunning, selectedDormant, isCurrentSession, messageCount)
											})
										]
									}), isSelected && selected.status === "active" && !selected.forkHandoffPending && selected.checkpointRefreshingAt === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "st-node-add",
										"aria-label": "从当前节点新建分支",
										onClick: () => beginAction("split"),
										children: "＋"
									})]
								}, point.node.id);
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "st-map-count",
							children: [space.nodes.length.toString().padStart(2, "0"), " 个分支"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "st-auto-mode",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {}), selected.parentId === null && children.length === 0 ? "自动建议 · 等待识别 4 个方向" : "建议分支 · 默认不自动运行"]
						}),
						action && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
							className: "st-action-panel",
							onSubmit: submitAction,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "st-action-heading",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "st-kicker",
										children: "请求当前节点的 Agent"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: actionTitle(action) })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "st-action-close",
										type: "button",
										"aria-label": "关闭",
										onClick: () => setAction(null),
										children: "×"
									})]
								}),
								(action === "split" || action === "rename") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["分支名称", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									autoFocus: true,
									value: title,
									maxLength: 80,
									required: true,
									onChange: (event) => setTitle(event.target.value),
									placeholder: "例如：用户需求"
								})] }),
								action === "split" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "st-return-explain",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "继承 Handoff 由父分支 Agent 自动整理。" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "节点会先以“继承准备中”出现；父 Agent 只提炼这个子分支需要的目标、事实、风险和第一步，不复制聊天记录。失败时可在节点上重试。" })]
								}),
								action === "checkpoint" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "st-return-explain",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "Current State 由当前分支 Agent 自动整理。" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "它只发布其他分支真正需要的结论、证据、依赖和下一步，不唤醒兄弟分支；失败会保留上一次进展。" })]
								}),
								action === "return" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "st-return-explain",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "最终 Handoff 由这个分支的 Agent 整理。" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										"它会回顾本分支对话，归纳结论、证据、风险和下一步，再调用 ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "thinking_return" }),
										"。成功后分支只读；失败则恢复为可继续状态。"
									] })]
								}),
								error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "st-action-error",
									role: "alert",
									children: error
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "st-action-footer",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: actionHint(action) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "st-primary",
										type: "submit",
										disabled: submitting,
										children: submitting ? "处理中…" : actionSubmitLabel(action)
									})]
								})
							]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
					className: "st-context",
					children: [
						!isCurrentSession && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "st-branch-door",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "st-kicker",
								children: "分支对话"
							}), selected.forkHandoffPending ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: selectedParentRunning ? "父 Agent 正在准备继承上下文" : "继承上下文尚未完成" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "子分支在 Handoff 完成前保持只读，不会偷用父分支原始对话。" }),
								startError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "st-action-error",
									role: "alert",
									children: startError
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "st-primary",
									type: "button",
									disabled: selectedParentRunning || retrying,
									onClick: retrySelectedHandoff,
									children: retrying ? "正在重试…" : selectedParentRunning ? "正在准备…" : "让父 Agent 重试"
								})
							] }) : selectedDormant && selected.status === "active" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "先给这个分支一条指令" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "节点选择不会切走页面。消息会直接发到这个独立分支，你仍留在思考树。" }),
								startError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "st-action-error",
									role: "alert",
									children: startError
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "st-primary",
									type: "button",
									disabled: starting || !kickoff.trim(),
									onClick: startSelectedBranch,
									children: starting ? "正在发送…" : "发送到分支"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									value: kickoff,
									onChange: (event) => setKickoff(event.target.value),
									"aria-label": "给分支的第一条指令"
								})
							] }) : selected.status === "returning" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "Agent 正在整理最终交接" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "完成后会自动封存，并把 Handoff 写入父分支；你可以进入查看进度。" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "st-primary",
									type: "button",
									onClick: () => openSession(selected.sessionId),
									children: "进入查看进度"
								})
							] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: selected.status === "returned" ? "查看这个分支的历史" : "继续这个分支" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: selected.status === "returned" ? "该分支已经结束，进入后只能查看历史。" : "只有这个按钮会切换 DSH 对话。" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "st-primary",
									type: "button",
									onClick: () => openSession(selected.sessionId),
									children: selected.status === "returned" ? "查看只读对话" : "进入分支对话"
								})
							] })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextCard, {
							eyebrow: "来自父分支",
							title: parent?.title ?? "根节点",
							body: selected.inheritedHandoff ?? (selected.forkHandoffPending ? "父 Agent 正在准备这个分支专属的继承 Handoff。" : parent ? "父分支为空，因此没有制造额外上下文。" : "这是头脑风暴的起点，没有父分支上下文。")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextCard, {
							eyebrow: "当前阶段",
							title: selectedDormant && selected.status === "active" ? "未启动" : statusLabel(selected),
							body: selected.returnedHandoff ?? selected.checkpointHandoff ?? (selected.forkHandoffPending ? "父 Agent 正在生成面向这个子分支的继承 Handoff；完成前分支不可输入。" : selectedDormant && selected.parentId ? "这个建议方向已经建成独立分支，但尚未运行。发送第一条指令后才会启动并进入它的对话。" : selected.checkpointRefreshingAt !== void 0 ? "Agent 正在从本分支完整对话刷新 Current State。" : selected.status === "returning" ? "Agent 正在把本分支对话整理成最终 Handoff；成功后父分支会收到一条持久化交接消息。" : "其他分支看不到这里的原始对话。完成一次有意义的讨论后，Agent 会发布 Current State；也可以点击“生成进展”显式刷新。"),
							accent: nodeTone(selected)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "st-related",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "st-kicker",
								children: "相关分支"
							}), [...siblings, ...children].length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "st-muted",
								children: "还没有相关分支。默认建议模式会在 Agent 识别到多个独立方向后自动建树；也可以点击图上的“＋”手动指定方向。"
							}) : [...siblings, ...children].map((node) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => selectNode(node),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `st-dot st-dot--${nodeTone(node)}` }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: node.title }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: node.parentId === selected.id ? "子分支" : "同级" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "↗" })
								]
							}, node.id))]
						})
					]
				})]
			})
		]
	});
}
function ThinkingRailToggle({ useProjection, openDetails }) {
	if (!useProjection("soloThinking")) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		className: "str-toggle",
		type: "button",
		onClick: openDetails,
		"aria-label": "打开思考树右栏",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			viewBox: "0 0 18 18",
			"aria-hidden": "true",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5 4.5 9 9m0 0 4-4.5M9 9v4.5" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "5",
					cy: "4.5",
					r: "2"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "13",
					cy: "4.5",
					r: "2"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "9",
					cy: "13.5",
					r: "2"
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "思考树" })]
	});
}
function ThinkingRailInputToggle({ useProjection, useSession, openDetails }) {
	const space = useProjection("soloThinking");
	const blank = useSession((snapshot) => snapshot.blank);
	if (!space || !blank) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		className: "str-input-toggle",
		type: "button",
		onClick: openDetails,
		"aria-label": "打开思考树右栏",
		title: "打开思考树",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			viewBox: "0 0 18 18",
			"aria-hidden": "true",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5 4.5 9 9m0 0 4-4.5M9 9v4.5" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "5",
					cy: "4.5",
					r: "2"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "13",
					cy: "4.5",
					r: "2"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "9",
					cy: "13.5",
					r: "2"
				})
			]
		})
	});
}
function ThinkingRail({ sessionId, useProjection, useSessions, openSession, sendToBranch, runCommand, openDetails }) {
	const space = useProjection("soloThinking");
	const layout = (0, react.useMemo)(() => space ? computeOrbitLayout(space) : null, [space]);
	const current = space?.nodes.find((node) => node.sessionId === sessionId);
	const [selectedNodeId, setSelectedNodeId] = (0, react.useState)(null);
	const selected = space?.nodes.find((node) => node.id === selectedNodeId) ?? current ?? space?.nodes[0];
	const sessionStates = useSessions((snapshot) => snapshot.byId);
	const selectedState = selected ? sessionStates[selected.sessionId] : void 0;
	const selectedRunning = selectedState?.running ?? false;
	const selectedDormant = selected?.dormant ?? selectedState?.blank ?? false;
	const [draft, setDraft] = (0, react.useState)("");
	const [sending, setSending] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const [splitOpen, setSplitOpen] = (0, react.useState)(false);
	const [splitTitle, setSplitTitle] = (0, react.useState)("");
	const [controlling, setControlling] = (0, react.useState)(false);
	(0, react.useEffect)(() => {
		if (!space) return;
		const key = `${sessionId}:${space.rootSessionId}`;
		if (autoOpenedSessions.has(key)) return;
		autoOpenedSessions.add(key);
		openDetails();
	}, [
		openDetails,
		sessionId,
		space?.rootSessionId
	]);
	(0, react.useEffect)(() => {
		if (selectedNodeId !== null && space?.nodes.some((node) => node.id === selectedNodeId)) return;
		setSelectedNodeId(current?.id ?? space?.nodes[0]?.id ?? null);
	}, [
		current?.id,
		selectedNodeId,
		space
	]);
	if (!space || !layout || !selected) return null;
	const points = new Map(layout.points.map((point) => [point.node.id, point]));
	const selectedIsCurrent = selected.sessionId === sessionId;
	const canControl = selected.status === "active" && !selected.forkHandoffPending && selected.checkpointRefreshingAt === void 0;
	const canSend = canControl && !selectedIsCurrent;
	const selectNode = (node) => {
		setSelectedNodeId(node.id);
		setDraft("");
		setSplitOpen(false);
		setError(null);
	};
	const send = async () => {
		const prompt = draft.trim();
		if (!prompt || !canSend) return;
		setSending(true);
		setError(null);
		try {
			await sendToBranch(selected.sessionId, prompt);
			setDraft("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	};
	const control = async (line) => {
		setControlling(true);
		setError(null);
		try {
			await runCommand(selected.sessionId, line);
			setSplitOpen(false);
			setSplitTitle("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setControlling(false);
		}
	};
	const split = async (event) => {
		event.preventDefault();
		const title = splitTitle.trim();
		if (!title) return;
		await control(`/thinking split ${JSON.stringify({ title })}`);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: "str-root",
		"aria-label": "思考树",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: railStyles }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "str-heading",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "SOLO THINKING" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [space.nodes.length, " 个方向"] })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", {
					className: selectedRunning ? "is-running" : "",
					children: selectedRunning ? "思考中" : selectedDormant ? "未启动" : statusLabel(selected)
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "str-map",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					viewBox: `0 0 ${layout.width} ${layout.height}`,
					preserveAspectRatio: "none",
					"aria-hidden": "true",
					children: layout.points.flatMap((point) => {
						if (!point.node.parentId) return [];
						const source = points.get(point.node.parentId);
						return source ? [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
							x1: source.x,
							y1: source.y,
							x2: point.x,
							y2: point.y
						}, point.node.id)] : [];
					})
				}), layout.points.map((point) => {
					const state = sessionStates[point.node.sessionId];
					const dormant = point.node.dormant ?? state?.blank ?? false;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: `str-node str-node--${nodeTone(point.node)}${point.node.id === selected.id ? " is-selected" : ""}`,
						style: {
							left: `${point.x / layout.width * 100}%`,
							top: `${point.y / layout.height * 100}%`
						},
						title: point.node.title,
						"aria-label": `选择分支 ${point.node.title}`,
						onClick: () => selectNode(point.node),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: clip(point.node.title, point.node.depth === 0 ? 7 : 5) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: dormant && point.node.status === "active" ? "未启动" : statusLabel(point.node) })]
					}, point.node.id);
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "str-selected",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "str-selected-title",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: selected.parentId ? "已选分支" : "主方向" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: selected.title })] }), !selectedIsCurrent && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => openSession(selected.sessionId),
							children: "进入对话 ↗"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: selected.returnedHandoff ?? selected.checkpointHandoff ?? selected.inheritedHandoff ?? "这个方向还没有发布 Handoff。" }),
					canControl && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "str-actions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: controlling || selectedRunning,
								onClick: () => setSplitOpen((open) => !open),
								children: "＋ 分裂"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: controlling || selectedRunning || selectedDormant,
								onClick: () => void control("/thinking checkpoint"),
								children: "● 进展"
							}),
							selected.parentId && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: controlling || selectedRunning || selectedDormant,
								onClick: () => void control("/thinking return"),
								children: "✓ 回传"
							})
						]
					}),
					splitOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "str-split",
						onSubmit: split,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							autoFocus: true,
							value: splitTitle,
							maxLength: 80,
							required: true,
							placeholder: "新分支名称",
							onChange: (event) => setSplitTitle(event.target.value)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							disabled: controlling,
							children: "创建"
						})]
					}),
					selectedIsCurrent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "str-current-note",
						children: "主会话消息仍从中间输入框发送。先点图中的子节点，即可在这里直接给分支发消息。"
					}) : canSend ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: "str-composer",
						onSubmit: (event) => {
							event.preventDefault();
							send();
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							value: draft,
							placeholder: selectedDormant ? "发送第一条指令，启动这个分支…" : "继续这个分支，不切换主会话…",
							"aria-label": `发送消息到 ${selected.title}`,
							onChange: (event) => setDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									send();
								}
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Enter 发送 · Shift+Enter 换行" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: sending || !draft.trim(),
							onClick: () => void send(),
							children: sending ? "发送中…" : "发送"
						})] })]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "str-current-note",
						children: selected.forkHandoffPending ? "父 Agent 正在准备继承上下文，完成后才能输入。" : selected.status === "returned" ? "这个分支已经回传，只能查看历史。" : "当前分支暂时不可输入。"
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "str-error",
						role: "alert",
						children: error
					})
				]
			})
		]
	});
}
function ContextCard({ eyebrow, title, body, accent = "active" }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: `st-card st-card--${accent}`,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "st-kicker",
				children: eyebrow
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: title }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "st-handoff",
				children: body
			})
		]
	});
}
function Legend({ color, label }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { "--legend-color": color } }), label] });
}
function nodeTone(node) {
	if (node.status === "returned") return "returned";
	if (node.status === "returning") return "returning";
	if (node.forkHandoffPending) return "preparing";
	if (node.checkpointRefreshingAt !== void 0) return "refreshing";
	return node.checkpointHandoff ? "checkpoint" : "active";
}
function statusLabel(node) {
	if (node.status === "returned") return "已完成";
	if (node.status === "returning") return "回传中";
	if (node.forkHandoffPending) return "继承准备中";
	if (node.checkpointRefreshingAt !== void 0) return "进展刷新中";
	return node.checkpointHandoff ? "已发布进展" : "发散中";
}
function activityLabel(node, running, parentRunning, blank) {
	if (node.status === "returning") return running ? "正在整理回传" : "等待回传";
	if (node.forkHandoffPending) return parentRunning ? "父 Agent 正在准备继承" : "继承待重试";
	if (node.checkpointRefreshingAt !== void 0) return running ? "正在刷新进展" : "等待刷新";
	if (running) return "正在思考";
	if (blank) return "尚未开始";
	return statusLabel(node);
}
function nodeActivityLabel(node, running, parentRunning, blank, current, messageCount) {
	if (node.status === "returning") return running ? "整理中" : "等待 Agent";
	if (node.forkHandoffPending) return parentRunning ? "父级整理中" : "可重试";
	if (node.checkpointRefreshingAt !== void 0) return running ? "刷新中" : "等待 Agent";
	if (running) return "思考中";
	if (blank) return "未启动";
	return current ? `${messageCount} 条对话` : "已启动";
}
function actionTitle(action) {
	if (action === "split") return "新建子分支";
	if (action === "rename") return "重命名当前分支";
	if (action === "checkpoint") return "发布阶段进展";
	return "让 Agent 整理并回传";
}
function actionHint(action) {
	if (action === "split") return "你只命名方向；父 Agent 自动完成分支继承。";
	if (action === "rename") return "只修改思考树里的节点名称。";
	if (action === "checkpoint") return "兄弟分支会在下一轮自动读取，不会被唤醒。";
	return "Agent 成功回传后该分支只读；未成功则自动恢复，可再次尝试。";
}
function actionSubmitLabel(action) {
	if (action === "split") return "创建分支";
	if (action === "rename") return "保存名称";
	if (action === "checkpoint") return "让 Agent 刷新";
	return "让 Agent 整理并回传";
}
function clip(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
const railStyles = `
  .str-toggle { display: inline-flex; align-items: center; gap: 5px; height: 26px; border: 1px solid rgba(22, 119, 255, .28); border-radius: 7px; background: rgba(22, 119, 255, .07); padding: 0 8px; color: #075fd6; font: 600 12px/1 inherit; cursor: pointer; }
  .str-toggle:hover { border-color: #1677ff; background: rgba(22, 119, 255, .12); }
  .str-toggle:focus-visible { outline: 2px solid #1677ff; outline-offset: 2px; }
  .str-toggle svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.35; }
  .str-input-toggle { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid rgba(22, 119, 255, .28); border-radius: 8px; background: rgba(22, 119, 255, .08); padding: 0; color: #075fd6; cursor: pointer; }
  .str-input-toggle:hover { border-color: #1677ff; background: rgba(22, 119, 255, .13); }
  .str-input-toggle:focus-visible { outline: 2px solid #1677ff; outline-offset: 2px; }
  .str-input-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.35; }
  .str-root, .str-root * { box-sizing: border-box; }
  .str-root { margin: -2px 0 16px; padding-bottom: 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #dce5f2); color: var(--dsw-alias-label-primary, #14233e); font-family: var(--ds-font-family, Inter, ui-sans-serif, system-ui, sans-serif); }
  .str-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
  .str-heading > div { display: grid; gap: 2px; }
  .str-heading span, .str-selected-title span { color: var(--dsw-alias-label-tertiary, #718199); font: 700 9px/1.3 var(--ds-font-family-code, ui-monospace, monospace); letter-spacing: .12em; }
  .str-heading strong { font-size: 14px; font-weight: 650; }
  .str-heading > i { border: 1px solid rgba(22, 119, 255, .22); border-radius: 999px; background: rgba(22, 119, 255, .07); padding: 4px 7px; color: #075fd6; font-size: 9px; font-style: normal; font-weight: 700; }
  .str-heading > i.is-running { animation: str-breathe 1.6s ease-in-out infinite; }
  .str-map { position: relative; height: 230px; overflow: hidden; border: 1px solid rgba(22, 119, 255, .2); border-radius: 10px; background-color: #f8fbff; background-image: linear-gradient(#e3ebf7 1px, transparent 1px), linear-gradient(90deg, #e3ebf7 1px, transparent 1px); background-size: 22px 22px; }
  .str-map::after { content: ""; position: absolute; inset: 7px; border: 1px solid rgba(22, 119, 255, .09); border-radius: 6px; pointer-events: none; }
  .str-map svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .str-map line { stroke: #a9c3e8; stroke-width: 2; stroke-dasharray: 5 6; }
  .str-node { position: absolute; z-index: 1; display: grid; place-content: center; gap: 1px; width: 48px; height: 48px; transform: translate(-50%, -50%); border: 2px solid #1677ff; border-radius: 50%; background: #fff; padding: 4px; color: #14233e; text-align: center; cursor: pointer; box-shadow: 0 5px 13px rgba(32, 79, 150, .12); transition: transform .15s ease, border-width .15s ease; }
  .str-node:first-of-type { width: 58px; height: 58px; }
  .str-node:hover, .str-node:focus-visible { z-index: 3; transform: translate(-50%, -50%) scale(1.08); outline: none; }
  .str-node.is-selected { z-index: 2; border-width: 4px; background: #eaf3ff; }
  .str-node--checkpoint { border-color: #d89a24; }
  .str-node--preparing { border-color: #138a9b; background: #eaf9fb; }
  .str-node--refreshing, .str-node--returning { border-color: #665bd4; background: #f0efff; }
  .str-node--returned { border-color: #8995a7; background: #f1f3f6; }
  .str-node b { overflow: hidden; font-size: 8px; line-height: 1.1; text-overflow: ellipsis; }
  .str-node small { color: #718199; font: 600 6px/1.1 var(--ds-font-family-code, ui-monospace, monospace); }
  .str-selected { margin-top: 10px; border-left: 3px solid #1677ff; background: var(--dsw-alias-bg-layer-1, #f7f9fc); padding: 11px 11px 11px 12px; }
  .str-selected-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .str-selected-title h3 { margin: 2px 0 0; font-size: 14px; line-height: 1.3; }
  .str-selected-title button { flex: none; border: 0; background: transparent; padding: 3px 0; color: #075fd6; font-size: 10px; font-weight: 650; cursor: pointer; }
  .str-selected > p { display: -webkit-box; overflow: hidden; margin: 8px 0 0; color: var(--dsw-alias-label-secondary, #4d607e); font-size: 11px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
  .str-actions { display: flex; gap: 5px; margin-top: 9px; }
  .str-actions button { flex: 1; border: 1px solid var(--dsw-alias-border-l2, #cbd8e9); border-radius: 6px; background: var(--dsw-alias-bg-base, #fff); padding: 6px 4px; color: var(--dsw-alias-label-secondary, #425573); font-size: 9px; font-weight: 650; cursor: pointer; }
  .str-actions button:hover:not(:disabled) { border-color: #1677ff; color: #075fd6; }
  .str-actions button:disabled { opacity: .45; cursor: not-allowed; }
  .str-split { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 7px; }
  .str-split input, .str-composer textarea { min-width: 0; border: 1px solid var(--dsw-alias-border-l2, #c3d3e9); border-radius: 7px; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #14233e); font: 11px/1.45 inherit; outline: none; }
  .str-split input { height: 30px; padding: 0 8px; }
  .str-split button, .str-composer button { border: 0; border-radius: 6px; background: #1677ff; padding: 0 9px; color: #fff; font-size: 10px; font-weight: 700; cursor: pointer; }
  .str-split input:focus, .str-composer textarea:focus { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22, 119, 255, .11); }
  .str-composer { display: grid; gap: 6px; margin-top: 9px; }
  .str-composer textarea { width: 100%; min-height: 70px; padding: 8px; resize: vertical; }
  .str-composer > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .str-composer > div span { color: var(--dsw-alias-label-tertiary, #718199); font-size: 8px; }
  .str-composer button { min-height: 27px; }
  .str-composer button:disabled, .str-split button:disabled { opacity: .5; cursor: wait; }
  .str-current-note { margin-top: 9px; border: 1px dashed rgba(22, 119, 255, .25); border-radius: 7px; padding: 8px; color: var(--dsw-alias-label-tertiary, #657790); font-size: 10px; line-height: 1.5; }
  .str-error { margin-top: 7px; border-left: 2px solid #d53f52; background: #fff1f3; padding: 6px 8px; color: #9b2030; font-size: 10px; line-height: 1.45; }
  @media (max-height: 700px) {
    .str-map { height: 140px; }
    .str-selected > p { -webkit-line-clamp: 2; }
    .str-composer textarea { min-height: 48px; }
  }
  @keyframes str-breathe { 50% { box-shadow: 0 0 0 4px rgba(22, 119, 255, .12); } }
  @media (prefers-reduced-motion: reduce) { .str-node { transition: none; } .str-heading > i.is-running { animation: none; } }
`;
const styles = `
  .st-shell, .st-empty { box-sizing: border-box; min-height: 100%; color: #13213c; background: #f4f8ff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .st-shell * , .st-empty * { box-sizing: border-box; }
  .st-shell { padding: 28px clamp(18px, 3vw, 42px) 36px; }
  .st-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; max-width: 1440px; margin: 0 auto 22px; }
  .st-header h1, .st-empty h1 { margin: 3px 0 0; max-width: 780px; font-size: clamp(30px, 4vw, 56px); line-height: .98; letter-spacing: -.055em; }
  .st-kicker { margin: 0; color: #5d6f8c; font: 700 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; }
  .st-status { display: flex; align-items: center; gap: 8px; border: 1px solid #ccd9ed; background: #fff; padding: 8px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; box-shadow: 0 6px 18px rgba(31, 76, 145, .08); }
  .st-status span { width: 8px; height: 8px; border-radius: 50%; background: #1677ff; }
  .st-status--checkpoint span { background: #e7a62b; }
  .st-status--preparing span { background: #138a9b; }
  .st-status--refreshing span { background: #7867d8; }
  .st-status--returning span { background: #5b6ee1; }
  .st-status--returned span { background: #8b95a5; }
  .st-workspace { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(300px, .7fr); gap: 18px; max-width: 1440px; margin: auto; }
  .st-map-panel, .st-card, .st-related { position: relative; overflow: hidden; border: 1px solid #cbd9ed; background: #fff; box-shadow: 0 14px 36px rgba(28, 69, 130, .09); }
  .st-map-panel { min-height: 680px; background-color: #f9fbff; background-image: linear-gradient(#dce6f6 1px, transparent 1px), linear-gradient(90deg, #dce6f6 1px, transparent 1px); background-size: 28px 28px; }
  .st-map-panel::before { content: ""; position: absolute; inset: 12px; border: 1px solid rgba(22, 119, 255, .15); pointer-events: none; }
  .st-map-canvas { position: relative; width: 100%; min-height: 630px; aspect-ratio: var(--st-map-ratio); }
  .st-map-canvas svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none; }
  .st-map-legend { position: absolute; z-index: 2; top: 26px; left: 28px; display: flex; flex-wrap: wrap; gap: 14px; color: #546681; font-size: 11px; }
  .st-map-legend span { display: flex; align-items: center; gap: 6px; }
  .st-map-legend i { width: 7px; height: 7px; border-radius: 50%; background: var(--legend-color); }
  .st-map-actions { position: absolute; z-index: 3; top: 20px; right: 22px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; max-width: 480px; }
  .st-map-actions button { border: 1px solid #bfd0e8; border-radius: 999px; background: rgba(255, 255, 255, .94); padding: 7px 10px; color: #263957; font-size: 11px; font-weight: 700; cursor: pointer; box-shadow: 0 5px 14px rgba(31, 76, 145, .07); }
  .st-map-actions button:first-child { border-color: #1677ff; background: #1677ff; color: #fff; }
  .st-map-actions button:hover:not(:disabled) { border-color: #1677ff; color: #075fd6; }
  .st-map-actions button:first-child:hover:not(:disabled) { color: #fff; background: #075fd6; }
  .st-map-actions button:disabled { cursor: not-allowed; opacity: .45; }
  .st-map-count { position: absolute; right: 27px; bottom: 24px; color: #73839b; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; }
  .st-auto-mode { position: absolute; z-index: 2; left: 27px; bottom: 21px; display: flex; align-items: center; gap: 7px; color: #48617f; font-size: 10px; font-weight: 750; letter-spacing: .04em; }
  .st-auto-mode i { width: 7px; height: 7px; border-radius: 50%; background: #1677ff; box-shadow: 0 0 0 4px rgba(22, 119, 255, .12); }
  .st-edges line { stroke: #adc6e9; stroke-width: 1.6; stroke-dasharray: 4 5; }
  .st-node-anchor { position: absolute; z-index: 2; width: 0; height: 0; }
  .st-node { display: grid; place-content: center; gap: 2px; width: var(--st-node-size); height: var(--st-node-size); border: 2px solid #1677ff; border-radius: 50%; background: #fff; padding: 8px; color: #14233e; cursor: pointer; outline: none; transform: translate(-50%, -50%); filter: drop-shadow(0 7px 9px rgba(28, 79, 156, .14)); transition: transform .18s ease, border-width .18s ease; }
  .st-node:hover, .st-node:focus-visible { border-width: 4px; transform: translate(-50%, -50%) scale(1.08); }
  .st-node.is-selected { border-width: 5px; background: #eaf3ff; }
  .st-node.is-running { animation: st-pulse 1.5s ease-in-out infinite; }
  .st-node--checkpoint { border-color: #e7a62b; }
  .st-node--preparing { border-color: #138a9b; background: #eaf9fb; }
  .st-node--refreshing { border-color: #7867d8; background: #f1efff; }
  .st-node--returning { border-color: #5b6ee1; background: #eef0ff; }
  .st-node--returned { border-color: #8b95a5; background: #f1f3f6; }
  .st-node-title { font-size: 12px; font-weight: 750; line-height: 1.1; }
  .st-node-state { color: #708098; font: 600 9px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
  .st-node-activity { color: #1677ff; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .st-node-add { position: absolute; z-index: 3; left: 30px; top: -58px; display: grid; place-items: center; width: 30px; height: 30px; border: 3px solid #fff; border-radius: 50%; background: #1677ff; color: #fff; font-size: 15px; font-weight: 800; cursor: pointer; outline: none; filter: drop-shadow(0 5px 7px rgba(22, 119, 255, .28)); transition: transform .18s ease, background .18s ease; }
  .st-node-add:hover, .st-node-add:focus-visible { background: #075fd6; transform: scale(1.12); }
  .st-action-panel { position: fixed; z-index: 20; top: 132px; right: clamp(18px, 3vw, 42px); width: min(420px, calc(100% - 36px)); max-height: calc(100dvh - 292px); overflow-y: auto; overscroll-behavior: contain; border: 1px solid #9fc0ed; background: rgba(255, 255, 255, .98); padding: 20px; box-shadow: 0 24px 60px rgba(21, 60, 119, .22); }
  .st-action-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 15px; }
  .st-action-heading h2 { margin: 4px 0 0; color: #13213c; font-size: 21px; letter-spacing: -.025em; }
  .st-action-close { border: 0; background: transparent; padding: 0 2px; color: #647590; font-size: 25px; line-height: 1; cursor: pointer; }
  .st-action-panel label { display: grid; gap: 6px; margin-top: 12px; color: #455875; font-size: 11px; font-weight: 750; }
  .st-action-panel input, .st-action-panel textarea { width: 100%; border: 1px solid #c5d5eb; border-radius: 5px; background: #f9fbff; padding: 10px 11px; color: #14233e; font: 500 13px/1.5 inherit; outline: none; }
  .st-action-panel textarea { min-height: 130px; resize: vertical; }
  .st-action-panel input:focus, .st-action-panel textarea:focus { border-color: #1677ff; box-shadow: 0 0 0 3px rgba(22, 119, 255, .12); }
  .st-return-explain { display: grid; gap: 7px; margin-top: 12px; border-left: 3px solid #5b6ee1; background: #f0f2ff; padding: 12px; color: #40526f; font-size: 12px; line-height: 1.55; }
  .st-return-explain strong { color: #263957; }
  .st-return-explain code { color: #4455c7; }
  .st-action-error { margin: 10px 0 0; border-left: 3px solid #d53f52; background: #fff1f3; padding: 8px 10px; color: #9b2030; font-size: 12px; }
  .st-action-footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin-top: 15px; }
  .st-action-footer > span { max-width: 230px; color: #718199; font-size: 10px; line-height: 1.45; }
  .st-primary { flex: none; border: 0; border-radius: 4px; background: #1677ff; padding: 9px 13px; color: #fff; font-size: 12px; font-weight: 750; cursor: pointer; }
  .st-primary:hover:not(:disabled) { background: #075fd6; }
  .st-primary:disabled { opacity: .55; cursor: wait; }
  .st-context { display: grid; align-content: start; gap: 14px; }
  .st-branch-door { border: 1px solid #1677ff; background: #eaf3ff; padding: 20px; box-shadow: 0 14px 36px rgba(28, 69, 130, .09); }
  .st-branch-door h2 { margin: 6px 0 7px; color: #13213c; font-size: 19px; letter-spacing: -.02em; }
  .st-branch-door > p:not(.st-kicker):not(.st-action-error) { margin: 0 0 12px; color: #506581; font-size: 12px; line-height: 1.55; }
  .st-branch-door textarea { width: 100%; min-height: 92px; border: 1px solid #a9c5ea; border-radius: 5px; background: #fff; padding: 10px; color: #14233e; font: 500 12px/1.55 inherit; resize: vertical; outline: none; }
  .st-branch-door textarea:focus { border-color: #1677ff; box-shadow: 0 0 0 3px rgba(22, 119, 255, .12); }
  .st-branch-door .st-primary { width: 100%; margin-bottom: 10px; }
  .st-card, .st-related { padding: 22px; }
  .st-card::before { content: ""; position: absolute; top: 0; left: 0; width: 5px; height: 100%; background: #1677ff; }
  .st-card--checkpoint::before { background: #e7a62b; }
  .st-card--preparing::before { background: #138a9b; }
  .st-card--refreshing::before { background: #7867d8; }
  .st-card--returning::before { background: #5b6ee1; }
  .st-card--returned::before { background: #8b95a5; }
  .st-card h2 { margin: 6px 0 13px; font-size: 20px; letter-spacing: -.025em; }
  .st-handoff { max-height: 250px; overflow: auto; color: #40526f; white-space: pre-wrap; font-size: 13px; line-height: 1.65; }
  .st-related { padding-bottom: 10px; }
  .st-related .st-kicker { margin-bottom: 12px; }
  .st-related button { width: 100%; display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 9px; border: 0; border-top: 1px solid #e1e8f3; background: transparent; padding: 13px 0; color: #20304a; text-align: left; cursor: pointer; }
  .st-related button:hover span:nth-child(2) { color: #075fd6; }
  .st-related small { color: #7b899e; font: 600 9px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
  .st-related b { color: #1677ff; }
  .st-dot { width: 8px; height: 8px; border-radius: 50%; background: #1677ff; }
  .st-dot--checkpoint { background: #e7a62b; }
  .st-dot--preparing { background: #138a9b; }
  .st-dot--refreshing { background: #7867d8; }
  .st-dot--returning { background: #5b6ee1; }
  .st-dot--returned { background: #8b95a5; }
  .st-muted { color: #7a899f; font-size: 13px; }
  .st-empty { display: grid; place-content: center; min-height: 640px; padding: 64px 24px; text-align: center; }
  .st-empty-mark { margin: 0 auto 18px; color: #1677ff; font-size: 84px; line-height: 1; }
  .st-empty h1 { margin: 12px auto 20px; }
  .st-empty > p:last-child { max-width: 660px; margin: 0 auto; color: #536581; line-height: 1.7; }
  .st-empty code { border: 1px solid #cbd9ed; background: #fff; padding: 2px 5px; color: #075fd6; }
  @keyframes st-pulse { 0%, 100% { filter: drop-shadow(0 7px 9px rgba(28, 79, 156, .14)); } 50% { filter: drop-shadow(0 0 16px rgba(22, 119, 255, .58)); } }
  @media (max-height: 760px) { .st-map-canvas { height: 300px; min-height: 300px; aspect-ratio: auto; } .st-map-legend { display: none; } .st-auto-mode { top: 22px; bottom: auto; } }
  @media (max-width: 900px) { .st-workspace { grid-template-columns: 1fr; } .st-map-panel { min-height: 560px; } .st-map-canvas { min-height: 540px; } }
  @media (max-width: 700px) { .st-map-actions { top: 50px; left: 20px; right: 20px; justify-content: flex-start; } .st-action-panel { top: 118px; right: 12px; width: calc(100% - 24px); max-height: calc(100dvh - 270px); } }
  @media (max-width: 560px) { .st-shell { padding: 18px 12px 24px; } .st-header { align-items: flex-start; flex-direction: column; } .st-map-legend { top: 20px; left: 20px; } .st-map-panel { min-height: 520px; } .st-map-canvas { min-height: 510px; } .st-action-footer { align-items: stretch; flex-direction: column; } .st-primary { width: 100%; } }
  @media (prefers-reduced-motion: reduce) { .st-node, .st-node-add { transition: none; animation: none; } }
`;
//#endregion
exports.ThinkingRail = ThinkingRail;
exports.ThinkingRailInputToggle = ThinkingRailInputToggle;
exports.ThinkingRailToggle = ThinkingRailToggle;
exports.ThinkingView = ThinkingView;
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
//# sourceMappingURL=client.js.map