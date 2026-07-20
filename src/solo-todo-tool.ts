import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	extractStructuredOrTextJson,
	mcpContentToText,
	soloToolResultIsError,
	type SoloCallToolLike,
} from "./solo-mcp-client.ts";

const TODO_STATE_ENTRY = "solo-todos";

type TodoStatus = "pending" | "in_progress" | "completed";
type TodoPriority = "low" | "medium" | "high";

export interface SoloTermTodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	priority?: TodoPriority;
	tags?: string[];
	notes?: string;
}

interface StoredTodoItem extends SoloTermTodoItem {
	/** Private Solo mirror identity; never included in tool result content/details. */
	soloTodoId?: number;
}

interface TodoStateEntryV1 {
	version: 1;
	todos: StoredTodoItem[];
	updatedAt: string;
}

interface TodoStateEntryV2 {
	version: 2;
	todos: StoredTodoItem[];
	updatedAt: string;
}

type TodoStateEntry = TodoStateEntryV1 | TodoStateEntryV2;

const TodoItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable todo id. Generated when omitted." })),
	title: Type.String({ description: "Todo text/title." }),
	status: Type.Optional(Type.String({ description: "pending, in_progress, or completed. Defaults to pending." })),
	priority: Type.Optional(Type.String({ description: "low, medium, or high." })),
	tags: Type.Optional(Type.Array(Type.String())),
	notes: Type.Optional(Type.String()),
});

const SoloTermTodoParams = Type.Object({
	action: Type.String({
		description:
			"Todo operation: write replaces the tracked list, list shows todos, add creates one todo, update changes one todo, complete marks one todo complete, clear removes local todos only.",
	}),
	items: Type.Optional(Type.Array(TodoItemSchema, { description: "Full todo list for action=write." })),
	id: Type.Optional(Type.String({ description: "Local todo id for update/complete." })),
	title: Type.Optional(Type.String({ description: "Todo title for add/update." })),
	status: Type.Optional(Type.String({ description: "pending, in_progress, or completed." })),
	priority: Type.Optional(Type.String({ description: "low, medium, or high." })),
	tags: Type.Optional(Type.Array(Type.String())),
	notes: Type.Optional(Type.String()),
});

type SoloTermTodoArgs = Static<typeof SoloTermTodoParams>;

export interface SoloTermTodoDeps {
	client: SoloCallToolLike;
	isActive: () => boolean;
	isClientReady: () => boolean;
}

interface MirrorReport {
	attempted: number;
	diagnostics: string[];
}

function normalizeStatus(value: unknown): TodoStatus {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "in_progress" || normalized === "in-progress" || normalized === "active") return "in_progress";
	if (normalized === "completed" || normalized === "complete" || normalized === "done") return "completed";
	return "pending";
}

function normalizePriority(value: unknown): TodoPriority | undefined {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
	return undefined;
}

function makeId(_title: string): string {
	return `todo-${randomUUID()}`;
}

function normalizeTodo(input: any, fallbackId?: string): StoredTodoItem {
	const title = String(input?.title ?? "").trim();
	const parsedSoloId = typeof input?.soloTodoId === "number" ? input.soloTodoId : Number(input?.soloTodoId);
	return {
		id: input?.id == null ? (fallbackId ?? makeId(title)) : String(input.id).trim(),
		title,
		status: normalizeStatus(input?.status),
		priority: normalizePriority(input?.priority),
		tags: Array.isArray(input?.tags)
			? input.tags.filter((tag: unknown): tag is string => typeof tag === "string" && tag.trim().length > 0)
			: undefined,
		notes: typeof input?.notes === "string" ? input.notes : undefined,
		...(Number.isSafeInteger(parsedSoloId) && parsedSoloId > 0 ? { soloTodoId: parsedSoloId } : {}),
	};
}

function normalizePublicTodo(input: unknown): SoloTermTodoItem {
	const { soloTodoId: _ignored, ...todo } = normalizeTodo(input);
	return todo;
}

function normalizeWriteTodos(inputs: readonly unknown[]): SoloTermTodoItem[] {
	const used = new Set<string>();
	return inputs.map((input, index) => {
		const suppliedId = (input as { id?: unknown } | null)?.id;
		if (suppliedId !== undefined && String(suppliedId).trim().length === 0) {
			throw new Error(`solo_todo write item ${index + 1} id must be non-empty.`);
		}
		const todo = normalizePublicTodo(input);
		if (used.has(todo.id)) throw new Error(`solo_todo write requires unique ids; duplicate id "${todo.id}".`);
		used.add(todo.id);
		return todo;
	});
}

function sanitizeReconstructedTodos(inputs: readonly unknown[]): StoredTodoItem[] {
	const used = new Set<string>();
	return inputs
		.map((input, index) => normalizeTodo(input, `legacy-todo-${index + 1}`))
		.filter((todo) => todo.title)
		.map((todo, index) => {
			let id = todo.id;
			if (!id || used.has(id)) {
				const base = `legacy-todo-${index + 1}`;
				id = base;
				let suffix = 2;
				while (used.has(id)) id = `${base}-${suffix++}`;
			}
			used.add(id);
			return { ...todo, id };
		});
}

function normalizeEntryData(value: unknown): TodoStateEntry | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<TodoStateEntry>;
	if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.todos)) return null;
	return {
		version: record.version,
		todos: sanitizeReconstructedTodos(record.todos),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
	};
}

function reconstructTodos(entries: readonly unknown[]): StoredTodoItem[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== TODO_STATE_ENTRY) continue;
		const state = normalizeEntryData(entry.data);
		if (state) return state.todos;
	}
	return [];
}

function formatTodos(todos: readonly SoloTermTodoItem[]): string {
	if (!todos.length) return "No SoloTerm todos.";
	return todos
		.map((todo) => {
			const mark = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[-]" : "[ ]";
			const tags = todo.tags?.length ? ` #${todo.tags.join(" #")}` : "";
			return `${mark} ${todo.id} — ${todo.title}${tags}`;
		})
		.join("\n");
}

function persist(pi: ExtensionAPI, todos: StoredTodoItem[]): void {
	pi.appendEntry<TodoStateEntryV2>(TODO_STATE_ENTRY, { version: 2, todos, updatedAt: new Date().toISOString() });
}

function extractSoloTodoId(result: unknown): number | undefined {
	const data = extractStructuredOrTextJson<any>(result as any);
	const value = data?.todo_id ?? data?.id ?? data?.todo?.todo_id ?? data?.todo?.id;
	const id = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function mirrorError(operation: string, resultOrError: unknown): string {
	if (resultOrError instanceof Error) return `${operation}: ${resultOrError.message}`;
	const text = mcpContentToText(resultOrError as any);
	return `${operation}: ${text || "Solo returned an error"}`;
}

function redactPrivateBinding(message: string, todo: StoredTodoItem): string {
	if (todo.soloTodoId === undefined) return message;
	return message.replace(new RegExp(`\\b${todo.soloTodoId}\\b`, "g"), "[private Solo binding]");
}

function createArgs(todo: StoredTodoItem): Record<string, unknown> {
	return {
		title: todo.title,
		...(todo.notes !== undefined ? { body: todo.notes } : {}),
		...(todo.priority !== undefined ? { priority: todo.priority } : {}),
		tags: ["solo", ...(todo.tags ?? [])],
		response_mode: "slim",
	};
}

function updateArgs(todo: StoredTodoItem, includeStatus = true): Record<string, unknown> {
	return {
		todo_id: todo.soloTodoId,
		title: todo.title,
		body: todo.notes ?? "",
		...(todo.priority !== undefined ? { priority: todo.priority } : {}),
		tags: ["solo", ...(todo.tags ?? [])],
		...(includeStatus ? { status: todo.status === "pending" ? "open" : todo.status } : {}),
		response_mode: "slim",
	};
}

async function callMirror(
	client: SoloCallToolLike,
	name: string,
	args: Record<string, unknown>,
	report: MirrorReport,
	todo: StoredTodoItem,
): Promise<any | undefined> {
	report.attempted++;
	const identity = `local todo ${todo.id}`;
	try {
		const result = await client.callTool(name, args);
		if (soloToolResultIsError(result)) {
			report.diagnostics.push(redactPrivateBinding(`${identity}: ${mirrorError(name, result)}`, todo));
			return undefined;
		}
		return result;
	} catch (error) {
		report.diagnostics.push(redactPrivateBinding(`${identity}: ${mirrorError(name, error)}`, todo));
		return undefined;
	}
}

function canAttemptTool(client: SoloCallToolLike, name: string): boolean {
	return client.hasTool(name) || client.canAttemptTool?.(name) === true;
}

async function syncBoundTodo(client: SoloCallToolLike, todo: StoredTodoItem, report: MirrorReport): Promise<void> {
	if (todo.soloTodoId === undefined) return;
	if (todo.status === "completed") {
		if (canAttemptTool(client, "todo_update")) await callMirror(client, "todo_update", updateArgs(todo, false), report, todo);
		else report.diagnostics.push(`local todo ${todo.id}: todo_update is unavailable; metadata remains local only`);
		if (canAttemptTool(client, "todo_complete")) {
			await callMirror(client, "todo_complete", {
				todo_id: todo.soloTodoId,
				completed: true,
				response_mode: "slim",
			}, report, todo);
		} else {
			report.diagnostics.push(`local todo ${todo.id}: todo_complete is unavailable; completion remains local only`);
		}
		return;
	}
	if (!canAttemptTool(client, "todo_update")) {
		report.diagnostics.push(`local todo ${todo.id}: todo_update is unavailable; changes remain local only`);
		return;
	}
	await callMirror(client, "todo_update", updateArgs(todo), report, todo);
}

async function createMirror(
	client: SoloCallToolLike,
	todo: StoredTodoItem,
	report: MirrorReport,
	onBound: () => void,
): Promise<void> {
	if (!canAttemptTool(client, "todo_create")) {
		report.diagnostics.push("todo_create is unavailable; todo remains local only");
		return;
	}
	const result = await callMirror(client, "todo_create", createArgs(todo), report, todo);
	if (!result) return;
	const soloTodoId = extractSoloTodoId(result);
	if (soloTodoId === undefined) {
		report.diagnostics.push(`local todo ${todo.id}: todo_create returned no usable todo_id; binding was not recorded and the Solo mirror may be orphaned`);
		return;
	}
	todo.soloTodoId = soloTodoId;
	// Make the new identity durable before any status/complete follow-up can fail.
	onBound();
	if (todo.status !== "pending") await syncBoundTodo(client, todo, report);
}

async function reconcileTodos(
	client: SoloCallToolLike,
	todos: StoredTodoItem[],
	onBound: () => void,
): Promise<MirrorReport> {
	const report: MirrorReport = { attempted: 0, diagnostics: [] };
	for (const todo of todos) {
		if (todo.soloTodoId === undefined) await createMirror(client, todo, report, onBound);
		else await syncBoundTodo(client, todo, report);
	}
	return report;
}

function publicTodos(todos: readonly StoredTodoItem[]): SoloTermTodoItem[] {
	return todos.map(({ soloTodoId: _private, ...todo }) => todo);
}

function resultText(todos: readonly StoredTodoItem[], report?: MirrorReport): string {
	const formatted = formatTodos(todos);
	if (!report?.diagnostics.length) return formatted;
	return `${formatted}\n\nMirror warnings:\n${report.diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`;
}

function details(todos: StoredTodoItem[], report?: MirrorReport): Record<string, unknown> {
	const mirrored = report !== undefined && report.attempted > 0 && report.diagnostics.length === 0;
	return {
		backend: mirrored ? "solo+session" : "session",
		todos: publicTodos(todos),
		...(report?.diagnostics.length ? { diagnostics: report.diagnostics } : {}),
	};
}

export function registerSoloTermTodoTool(pi: ExtensionAPI, deps: SoloTermTodoDeps): void {
	let todos: StoredTodoItem[] = [];

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		todos = reconstructTodos(ctx.sessionManager.getBranch());
	});

	pi.registerTool<typeof SoloTermTodoParams, Record<string, unknown>>({
		name: "solo_todo",
		label: "SoloTerm Todo",
		description: "Track SoloTerm workflow tasks. Pi session state is authoritative and mirrors to Solo when available.",
		promptSnippet: "Track SoloTerm checklist/task progress.",
		promptGuidelines: ["Use solo_todo when a workflow asks you to create or update checklist/task progress in SoloTerm."],
		parameters: SoloTermTodoParams,
		async execute(_toolCallId, params: SoloTermTodoArgs, _signal: AbortSignal | undefined) {
			if (!deps.isActive()) throw new Error("SoloTerm mode is not active.");

			const action = String(params.action ?? "list").trim().toLowerCase();
			if (action === "list") {
				return { content: [{ type: "text" as const, text: formatTodos(todos) }], details: details(todos) };
			}

			if (action === "write") {
				const previousTodos = todos;
				const bindings = new Map(previousTodos.flatMap((todo) => todo.soloTodoId === undefined ? [] : [[todo.id, todo.soloTodoId] as const]));
				todos = normalizeWriteTodos(Array.isArray(params.items) ? params.items : [])
					.filter((todo) => todo.title)
					.map((todo) => ({ ...todo, ...(bindings.has(todo.id) ? { soloTodoId: bindings.get(todo.id) } : {}) }));
				// Record authoritative local state before any remote I/O; persist again below
				// because reconciliation may add a Solo binding.
				persist(pi, todos);
				const report = deps.isClientReady()
					? await reconcileTodos(deps.client, todos, () => persist(pi, todos))
					: { attempted: 0, diagnostics: ["Solo client is not ready; todos remain local only"] };
				const retainedIds = new Set(todos.map((todo) => todo.id));
				const removedMirrors = previousTodos.filter((todo) => todo.soloTodoId !== undefined && !retainedIds.has(todo.id));
				if (removedMirrors.length) {
					report.diagnostics.push(`write removed local todo(s), but their Solo mirrors were not deleted: ${removedMirrors.map((todo) => todo.id).join(", ")}`);
				}
				persist(pi, todos);
				return { content: [{ type: "text" as const, text: resultText(todos, report) }], details: details(todos, report) };
			}

			if (action === "clear") {
				todos = [];
				persist(pi, todos);
				const diagnostic = "Cleared authoritative Pi session todos only; existing Solo mirrors were not deleted.";
				return { content: [{ type: "text" as const, text: diagnostic }], details: { backend: "session", todos, diagnostics: [diagnostic] } };
			}

			if (action === "add") {
				if (!params.title?.trim()) throw new Error("solo_todo add requires title.");
				if (params.id !== undefined && !params.id.trim()) throw new Error("solo_todo add id must be non-empty.");
				let todo = normalizePublicTodo(params);
				if (params.id !== undefined && todos.some((existing) => existing.id === todo.id)) {
					throw new Error(`solo_todo add requires a unique id; duplicate id "${todo.id}".`);
				}
				while (todos.some((existing) => existing.id === todo.id)) todo = { ...todo, id: makeId(todo.title) };
				todos = [...todos, todo];
				// Persist before mirroring so a slow or interrupted remote call cannot erase
				// the authoritative local addition. Persist again to save any new binding.
				persist(pi, todos);
				const report = deps.isClientReady()
					? await reconcileTodos(deps.client, [todo], () => persist(pi, todos))
					: { attempted: 0, diagnostics: ["Solo client is not ready; todo remains local only"] };
				persist(pi, todos);
				return { content: [{ type: "text" as const, text: resultText(todos, report) }], details: details(todos, report) };
			}

			if (action === "update" || action === "complete") {
				if (!params.id?.trim()) throw new Error(`${action} requires id.`);
				const index = todos.findIndex((todo) => todo.id === params.id);
				if (index < 0) throw new Error(`No SoloTerm todo with id ${params.id}.`);
				const current = todos[index]!;
				const updated: StoredTodoItem = {
					...current,
					title: params.title?.trim() || current.title,
					status: action === "complete" ? "completed" : params.status ? normalizeStatus(params.status) : current.status,
					priority: params.priority ? normalizePriority(params.priority) : current.priority,
					tags: params.tags ?? current.tags,
					notes: params.notes ?? current.notes,
				};
				todos = todos.map((todo, todoIndex) => todoIndex === index ? updated : todo);
				// Keep the local source of truth durable before attempting its Solo mirror.
				persist(pi, todos);
				const report: MirrorReport = { attempted: 0, diagnostics: [] };
				if (!deps.isClientReady()) report.diagnostics.push("Solo client is not ready; change remains local only");
				else if (updated.soloTodoId === undefined) report.diagnostics.push("Todo has no Solo binding; change remains local only");
				else await syncBoundTodo(deps.client, updated, report);
				return { content: [{ type: "text" as const, text: resultText(todos, report) }], details: details(todos, report) };
			}

			throw new Error(`Unknown solo_todo action: ${action}`);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("accent", "☐")} ${theme.fg("toolTitle", theme.bold("solo_todo"))} ${theme.fg("accent", String(args.action ?? "list"))}`, 0, 0);
		},
		renderResult(result, _opts, theme, context) {
			const count = Array.isArray(result.details.todos) ? result.details.todos.length : 0;
			const warnings = Array.isArray(result.details.diagnostics) ? result.details.diagnostics.length : 0;
			const state = context.isError ? "error" : warnings > 0 ? "warning" : "success";
			const icon = theme.fg(state, context.isError ? "✘" : warnings > 0 ? "⚠" : "✓");
			const content = result.content[0];
			const errorText = content?.type === "text" ? content.text : "solo_todo failed";
			const summary = context.isError ? errorText.slice(0, 140) : warnings > 0 ? `${count} todos · ${warnings} mirror warning${warnings === 1 ? "" : "s"}` : `${count} todos`;
			return new Text(`${icon} ${theme.fg("toolTitle", theme.bold("solo_todo"))} ${theme.fg(context.isError ? "error" : warnings > 0 ? "warning" : "dim", summary)}`, 0, 0);
		},
	});
}

export const __test__ = { formatTodos, makeId, normalizeTodo, reconstructTodos, TODO_STATE_ENTRY };
