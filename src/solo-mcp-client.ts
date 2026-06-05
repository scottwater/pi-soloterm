/**
 * Minimal Solo MCP client for pi-soloterm.
 *
 * Portions of the design and behavior are adapted from pi-solo
 * (MIT, Copyright (c) 2026 HazAT). See NOTICE.md for attribution.
 *
 * This client does not implement a server. Solo ships the MCP server and a
 * bundled stdio helper; this module only launches that helper and speaks
 * JSON-RPC/MCP over its stdio streams.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export const DEFAULT_SOLO_MCP_HELPER = "/Applications/Solo.app/Contents/MacOS/mcp";
export const DEFAULT_SOLO_APP_DATA_DIR = join(homedir(), ".config", "soloterm");
export const SOLO_MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
	jsonrpc: "2.0";
	id: number;
	result: T;
}

export interface JsonRpcError {
	jsonrpc: "2.0";
	id: number;
	error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage<T = unknown> = JsonRpcNotification | JsonRpcSuccess<T> | JsonRpcError;
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

export interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpContentItem {
	type: "text" | "image" | "resource" | string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; text?: string; mimeType?: string };
}

export interface McpToolCallResult {
	content?: McpContentItem[];
	isError?: boolean;
	structuredContent?: unknown;
}

export interface McpInitializeResult {
	protocolVersion?: string;
	serverInfo?: { name?: string; version?: string };
	instructions?: string;
	capabilities?: unknown;
}

export interface SoloIdentity {
	process_id?: string | number;
	actor?: string;
	project?: { id?: string | number; name?: string; path?: string };
	[k: string]: unknown;
}

export type SoloMcpState = "stopped" | "warming" | "ready" | "failed";

export interface SoloMcpTransport {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals | string): boolean | void;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
}

export type SoloMcpSpawn = (
	command: string,
	args: string[],
	options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => SoloMcpTransport;

export interface SoloMcpClientOptions {
	helperPath?: string;
	appDataDir?: string;
	soloProcessId?: string;
	clientName?: string;
	clientVersion?: string;
	idleCloseMs?: number;
	exists?: (path: string) => boolean;
	spawn?: SoloMcpSpawn;
	onStateChange?: (client: SoloMcpClient) => void;
}

export interface SoloCallToolLike {
	callTool(name: string, args?: unknown): Promise<McpToolCallResult>;
	hasTool(name: string): boolean;
	tools: McpToolDef[];
	identity?: SoloIdentity;
}

export function parseJsonRpcLine(line: string): JsonRpcMessage | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.jsonrpc !== "2.0") return undefined;
	if (typeof record.method === "string" && record.id === undefined) return record as unknown as JsonRpcNotification;
	if (typeof record.id === "number" && ("result" in record || "error" in record)) {
		return record as JsonRpcResponse;
	}
	return undefined;
}

export function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

export function extractTextJson<T>(result: McpToolCallResult): T | undefined {
	const text = result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function extractStructuredOrTextJson<T>(result: McpToolCallResult): T | undefined {
	if (result.structuredContent !== undefined && result.structuredContent !== null) {
		return result.structuredContent as T;
	}
	return extractTextJson<T>(result);
}

export function mcpContentToText(result: McpToolCallResult): string {
	if (!result.content?.length) return "";
	return result.content
		.map((item) => {
			if (item.type === "text") return item.text ?? "";
			if (item.type === "resource") return item.resource?.text ?? `[resource: ${item.resource?.uri ?? "?"}]`;
			if (item.type === "image") return `[image omitted: ${item.mimeType ?? "unknown"}]`;
			return `[${item.type} content]`;
		})
		.filter(Boolean)
		.join("\n");
}

export function soloToolResultIsError(result: McpToolCallResult): boolean {
	if (result.isError === true) return true;
	const text = mcpContentToText(result);
	return /^Solo tool call failed:/m.test(text) || /^Validation failed for tool/m.test(text);
}

function defaultSpawn(command: string, args: string[], options: Parameters<SoloMcpSpawn>[2]): SoloMcpTransport {
	return spawn(command, args, options) as ChildProcessByStdio<Writable, Readable, Readable>;
}

export class SoloMcpClient implements SoloCallToolLike {
	private readonly helperPath: string;
	private readonly appDataDir: string;
	private readonly soloProcessId?: string;
	private readonly clientName: string;
	private readonly clientVersion: string;
	private readonly idleCloseMs: number;
	private readonly exists: (path: string) => boolean;
	private readonly spawnTransport: SoloMcpSpawn;
	private readonly onStateChange?: (client: SoloMcpClient) => void;
	private readonly enqueueCall = createSerialQueue();

	private child?: SoloMcpTransport;
	private buf = "";
	private nextId = 1;
	private stopped = false;
	private idleTimer?: NodeJS.Timeout;
	private ensurePromise?: Promise<void>;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();

	state: SoloMcpState = "stopped";
	tools: McpToolDef[] = [];
	serverInfo?: McpInitializeResult;
	identity?: SoloIdentity;
	lastError?: string;

	constructor(options: SoloMcpClientOptions = {}) {
		this.helperPath = options.helperPath ?? process.env.SOLO_MCP_HELPER ?? DEFAULT_SOLO_MCP_HELPER;
		this.appDataDir = options.appDataDir ?? process.env.SOLOTERM_APP_DATA_DIR ?? DEFAULT_SOLO_APP_DATA_DIR;
		this.soloProcessId = options.soloProcessId ?? process.env.SOLO_PROCESS_ID;
		this.clientName = options.clientName ?? "pi-soloterm";
		this.clientVersion = options.clientVersion ?? "0.1.0";
		this.idleCloseMs = options.idleCloseMs ?? 5_000;
		this.exists = options.exists ?? existsSync;
		this.spawnTransport = options.spawn ?? defaultSpawn;
		this.onStateChange = options.onStateChange;
	}

	async start(): Promise<void> {
		if (this.stopped) return;
		if (!this.exists(this.helperPath)) {
			this.failState(`Solo MCP helper not found at ${this.helperPath}`);
			return;
		}
		await this.ensureChild();
		this.touchIdle();
	}

	stop(): void {
		this.stopped = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.killChild();
		this.state = "stopped";
		this.emitState();
	}

	async restart(): Promise<void> {
		this.killChild();
		this.stopped = false;
		this.state = "stopped";
		await this.start();
	}

	async refreshTools(): Promise<void> {
		await this.ensureChild();
		await this.loadTools();
		this.touchIdle();
	}

	hasTool(name: string): boolean {
		return this.tools.some((tool) => tool.name === name);
	}

	getTool(name: string): McpToolDef | undefined {
		return this.tools.find((tool) => tool.name === name);
	}

	missingTools(names: readonly string[]): string[] {
		return names.filter((name) => !this.hasTool(name));
	}

	isReady(): boolean {
		return !this.stopped && this.state !== "failed" && this.exists(this.helperPath);
	}

	isMcpDisabled(): boolean {
		return this.tools.length === 0 && this.serverInfo?.instructions?.toLowerCase().includes("disabled") === true;
	}

	async callTool(name: string, args: unknown = {}): Promise<McpToolCallResult> {
		return this.enqueueCall(async () => {
			await this.ensureChild();
			try {
				return await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
			} finally {
				this.touchIdle();
			}
		});
	}

	private async ensureChild(): Promise<void> {
		if (this.stopped) throw new Error("Solo MCP client stopped");
		if (this.child) return;
		if (this.ensurePromise) return this.ensurePromise;
		if (!this.exists(this.helperPath)) throw new Error(`Solo MCP helper not found at ${this.helperPath}`);

		this.state = "warming";
		this.lastError = undefined;
		this.emitState();

		this.ensurePromise = (async () => {
			try {
				this.spawnChild();
				await this.handshake();
				await this.loadTools();
				await this.identifySession();
				this.state = "ready";
				this.lastError = undefined;
				this.emitState();
			} catch (error) {
				this.killChild();
				this.failState(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				this.ensurePromise = undefined;
			}
		})();
		return this.ensurePromise;
	}

	private spawnChild(): void {
		const env = { ...process.env, SOLOTERM_APP_DATA_DIR: this.appDataDir };
		if (this.soloProcessId) env.SOLO_PROCESS_ID = this.soloProcessId;

		const child = this.spawnTransport(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"], env });
		this.child = child;
		this.buf = "";

		child.stdout.setEncoding?.("utf8");
		child.stdout.on("data", (chunk: Buffer | string) => this.handleStdout(String(chunk)));
		child.stderr.setEncoding?.("utf8");
		child.stderr.on("data", () => {
			// Solo helper logs are intentionally not surfaced unless a request fails.
		});
		child.on("exit", (code, signal) => {
			this.failPending(new Error(`Solo MCP helper exited (code=${code ?? "?"} signal=${signal ?? "?"})`));
			this.child = undefined;
			if (!this.stopped && this.state === "ready") {
				this.state = "stopped";
				this.emitState();
			}
		});
		child.on("error", (error) => {
			this.lastError = error.message;
		});
	}

	private handleStdout(chunk: string): void {
		this.buf += chunk;
		while (true) {
			const newline = this.buf.indexOf("\n");
			if (newline < 0) return;
			const line = this.buf.slice(0, newline);
			this.buf = this.buf.slice(newline + 1);
			const message = parseJsonRpcLine(line);
			if (!message || !("id" in message)) continue;
			this.handleResponse(message as JsonRpcResponse);
		}
	}

	private handleResponse(message: JsonRpcResponse): void {
		const handler = this.pending.get(message.id);
		if (!handler) return;
		this.pending.delete(message.id);
		clearTimeout(handler.timer);
		if ("error" in message) {
			handler.reject(new Error(`${message.error.message} (code ${message.error.code})`));
		} else {
			handler.resolve(message.result);
		}
	}

	private async handshake(): Promise<void> {
		this.serverInfo = await this.request<McpInitializeResult>("initialize", {
			protocolVersion: SOLO_MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: this.clientName, version: this.clientVersion },
		});
		await this.notify("notifications/initialized");
	}

	private async loadTools(): Promise<void> {
		const result = await this.request<{ tools?: McpToolDef[] }>("tools/list");
		this.tools = Array.isArray(result.tools) ? result.tools : [];
	}

	private async identifySession(): Promise<void> {
		const name = this.hasTool("identify_session") ? "identify_session" : this.hasTool("whoami") ? "whoami" : undefined;
		if (!name) return;
		try {
			const args = name === "identify_session" && this.soloProcessId ? { solo_process_id: Number(this.soloProcessId) } : {};
			const result = await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
			this.identity = extractStructuredOrTextJson<SoloIdentity>(result);
		} catch {
			// Identity is useful but never required for SoloTerm operation.
		}
	}

	private request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("Solo MCP helper not running"));

		const id = this.nextId++;
		const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Solo MCP request '${method}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				timer,
				resolve: (value) => resolve(value as T),
				reject,
			});

			try {
				child.stdin.write(`${JSON.stringify(payload)}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private async notify(method: string, params?: unknown): Promise<void> {
		const child = this.child;
		if (!child) return;
		const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		try {
			child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// Notification is best effort.
		}
	}

	private touchIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.stopped || this.idleCloseMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.pending.size > 0) {
				this.touchIdle();
				return;
			}
			this.killChild();
			if (!this.stopped) {
				this.state = "stopped";
				this.emitState();
			}
		}, this.idleCloseMs);
		this.idleTimer.unref?.();
	}

	private killChild(): void {
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// Already gone.
		}
	}

	private failPending(error: Error): void {
		for (const handler of this.pending.values()) {
			clearTimeout(handler.timer);
			handler.reject(error);
		}
		this.pending.clear();
	}

	private failState(message: string): void {
		this.state = "failed";
		this.lastError = message;
		this.emitState();
	}

	private emitState(): void {
		this.onStateChange?.(this);
	}
}
