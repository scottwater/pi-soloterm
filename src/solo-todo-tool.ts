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

export interface SoloTermTodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	priority?: "low" | "medium" | "high";
	tags?: string[];
	notes?: string;
}

interface TodoStateEntry {
	version: 1;
	todos: SoloTermTodoItem[];
	updatedAt: string;
}

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
			"Todo operation: write replaces the tracked list, list shows todos, add creates one todo, update changes one todo, complete marks one todo complete, clear removes fallback todos.",
	}),
	items: Type.Optional(Type.Array(TodoItemSchema, { description: "Full todo list for action=write." })),
	id: Type.Optional(Type.String({ description: "Todo id for update/complete." })),
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

function normalizeStatus(value: unknown): TodoStatus {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "in_progress" || normalized === "in-progress" || normalized === "active") return "in_progress";
	if (normalized === "completed" || normalized === "complete" || normalized === "done") return "completed";
	return "pending";
}

function normalizePriority(value: unknown): SoloTermTodoItem["priority"] {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
	return undefined;
}

function makeId(title: string): string {
	return `${Date.now().toString(36)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "todo"}`;
}

function normalizeTodo(input: any): SoloTermTodoItem {
	const title = String(input?.title ?? "").trim();
	return {
		id: String(input?.id ?? makeId(title)),
		title,
		status: normalizeStatus(input?.status),
		priority: normalizePriority(input?.priority),
		tags: Array.isArray(input?.tags) ? input.tags.filter((tag: unknown): tag is string => typeof tag === "string" && tag.trim().length > 0) : undefined,
		notes: typeof input?.notes === "string" ? input.notes : undefined,
	};
}

function normalizeEntryData(value: unknown): TodoStateEntry | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<TodoStateEntry>;
	if (record.version !== 1 || !Array.isArray(record.todos)) return null;
	return {
		version: 1,
		todos: record.todos.map(normalizeTodo).filter((todo) => todo.title),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
	};
}

function reconstructTodos(entries: readonly unknown[]): SoloTermTodoItem[] {
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

function persist(pi: ExtensionAPI, todos: SoloTermTodoItem[]): void {
	pi.appendEntry<TodoStateEntry>(TODO_STATE_ENTRY, { version: 1, todos, updatedAt: new Date().toISOString() });
}

function soloTodosAvailable(client: SoloCallToolLike): boolean {
	return client.hasTool("todo_create") && client.hasTool("todo_list") && client.hasTool("todo_update") && client.hasTool("todo_complete");
}

function extractSoloTodos(result: any): any[] {
	const data = extractStructuredOrTextJson<any>(result);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.todos)) return data.todos;
	return [];
}

async function listSoloTodos(client: SoloCallToolLike): Promise<string | undefined> {
	const result = await client.callTool("todo_list", { tags: ["solo"] });
	if (soloToolResultIsError(result)) return undefined;
	const todos = extractSoloTodos(result);
	if (!todos.length) return mcpContentToText(result) || "No Solo SoloTerm todos.";
	return todos
		.map((todo: any) => {
			const id = todo.id ?? todo.todo_id ?? "?";
			const title = todo.title ?? todo.text ?? todo.name ?? JSON.stringify(todo);
			const done = todo.completed === true || todo.status === "completed" ? "[x]" : "[ ]";
			return `${done} ${id} — ${title}`;
		})
		.join("\n");
}

async function mirrorToSolo(client: SoloCallToolLike, todos: SoloTermTodoItem[]): Promise<void> {
	if (!soloTodosAvailable(client)) return;
	for (const todo of todos) {
		try {
			const created = await client.callTool("todo_create", {
				title: todo.title,
				priority: todo.priority,
				tags: ["solo", ...(todo.tags ?? [])],
			});
			if (soloToolResultIsError(created)) continue;
			const data = extractStructuredOrTextJson<any>(created);
			const soloId = data?.todo_id ?? data?.id ?? data?.todo?.id;
			if (soloId != null && todo.status === "completed") await client.callTool("todo_complete", { todo_id: soloId, completed: true });
			else if (soloId != null && todo.status === "in_progress") await client.callTool("todo_update", { todo_id: soloId, status: "in_progress" });
		} catch {
			// Fallback state remains authoritative if Solo todo mirroring fails.
		}
	}
}

export function registerSoloTermTodoTool(pi: ExtensionAPI, deps: SoloTermTodoDeps): void {
	let todos: SoloTermTodoItem[] = [];

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		todos = reconstructTodos(ctx.sessionManager.getBranch());
	});

	pi.registerTool({
		name: "solo_todo",
		label: "SoloTerm Todo",
		description:
			"Track SoloTerm workflow tasks. Uses Solo todos when available and Pi session state as a fallback.",
		promptSnippet: "Track SoloTerm checklist/task progress.",
		promptGuidelines: ["Use solo_todo when a workflow asks you to create or update checklist/task progress in SoloTerm."],
		parameters: SoloTermTodoParams as any,
		async execute(_toolCallId, params: SoloTermTodoArgs) {
			if (!deps.isActive()) throw new Error("SoloTerm mode is not active.");

			const action = String(params.action ?? "list").trim().toLowerCase();
			if (action === "list") {
				if (deps.isClientReady() && soloTodosAvailable(deps.client)) {
					const soloList = await listSoloTodos(deps.client);
					if (soloList) return { content: [{ type: "text" as const, text: soloList }], details: { backend: "solo", todos } };
				}
				return { content: [{ type: "text" as const, text: formatTodos(todos) }], details: { backend: "session", todos } };
			}

			if (action === "write") {
				todos = Array.isArray(params.items) ? params.items.map(normalizeTodo).filter((todo) => todo.title) : [];
				persist(pi, todos);
				if (deps.isClientReady()) await mirrorToSolo(deps.client, todos);
				return { content: [{ type: "text" as const, text: formatTodos(todos) }], details: { backend: soloTodosAvailable(deps.client) ? "solo+session" : "session", todos } };
			}

			if (action === "clear") {
				todos = [];
				persist(pi, todos);
				return { content: [{ type: "text" as const, text: "Cleared SoloTerm fallback todos." }], details: { backend: "session", todos } };
			}

			if (action === "add") {
				if (!params.title?.trim()) throw new Error("solo_todo add requires title.");
				const todo = normalizeTodo(params);
				todos = [...todos, todo];
				persist(pi, todos);
				if (deps.isClientReady()) await mirrorToSolo(deps.client, [todo]);
				return { content: [{ type: "text" as const, text: formatTodos(todos) }], details: { backend: "session", todos } };
			}

			if (action === "update" || action === "complete") {
				if (!params.id?.trim()) throw new Error(`${action} requires id.`);
				let found = false;
				todos = todos.map((todo) => {
					if (todo.id !== params.id) return todo;
					found = true;
					return {
						...todo,
						title: params.title?.trim() || todo.title,
						status: action === "complete" ? "completed" : params.status ? normalizeStatus(params.status) : todo.status,
						priority: params.priority ? normalizePriority(params.priority) : todo.priority,
						tags: params.tags ?? todo.tags,
						notes: params.notes ?? todo.notes,
					};
				});
				if (!found) throw new Error(`No SoloTerm todo with id ${params.id}.`);
				persist(pi, todos);
				return { content: [{ type: "text" as const, text: formatTodos(todos) }], details: { backend: "session", todos } };
			}

			throw new Error(`Unknown solo_todo action: ${action}`);
		},
		renderCall(args: Record<string, unknown>, theme: any) {
			return new Text(`${theme.fg("accent", "☐")} ${theme.fg("toolTitle", theme.bold("solo_todo"))} ${theme.fg("accent", String(args.action ?? "list"))}`, 0, 0);
		},
		renderResult(result: any, _opts: any, theme: any, context: any) {
			const count = Array.isArray(result.details?.todos) ? result.details.todos.length : 0;
			const icon = context.isError ? theme.fg("error", "✘") : theme.fg("success", "✓");
			return new Text(`${icon} ${theme.fg("toolTitle", theme.bold("solo_todo"))} ${theme.fg(context.isError ? "error" : "dim", context.isError ? String(result.content?.[0]?.text ?? "solo_todo failed").slice(0, 140) : `${count} todos`)}`, 0, 0);
		},
	});
}

export const __test__ = { formatTodos, normalizeTodo, reconstructTodos, TODO_STATE_ENTRY };
