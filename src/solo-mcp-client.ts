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

import { spawn } from "node:child_process";
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
	kill(signal?: NodeJS.Signals | number): boolean | void;
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
	requestTimeoutMs?: number;
	diagnosticLimit?: number;
	exists?: (path: string) => boolean;
	spawn?: SoloMcpSpawn;
	onStateChange?: (client: SoloMcpClient) => void;
}

export interface SoloCallToolLike {
	callTool(name: string, args?: unknown, signal?: AbortSignal): Promise<McpToolCallResult>;
	hasTool(name: string): boolean;
	/** True when a missing catalog can be reloaded by the next authoritative call. */
	canAttemptTool?(name: string): boolean;
	tools: McpToolDef[];
	identity?: SoloIdentity;
	identityError?: string;
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
	if (typeof record.id === "number" && "result" in record) {
		return { jsonrpc: "2.0", id: record.id, result: record.result };
	}
	if (typeof record.id === "number" && record.error && typeof record.error === "object") {
		const error = record.error as Record<string, unknown>;
		if (typeof error.code === "number" && typeof error.message === "string") {
			return {
				jsonrpc: "2.0",
				id: record.id,
				error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
			};
		}
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
	return spawn(command, args, options);
}

export class SoloMcpClient implements SoloCallToolLike {
	private readonly helperPath: string;
	private readonly appDataDir: string;
	private readonly soloProcessId?: number;
	private readonly clientName: string;
	private readonly clientVersion: string;
	private readonly idleCloseMs: number;
	private readonly requestTimeoutMs: number;
	private readonly diagnosticLimit: number;
	private readonly exists: (path: string) => boolean;
	private readonly spawnTransport: SoloMcpSpawn;
	private readonly onStateChange?: (client: SoloMcpClient) => void;
	private readonly enqueueCall = createSerialQueue();

	private child?: SoloMcpTransport;
	private buf = "";
	private diagnostics = "";
	private nextId = 1;
	private stopped = false;
	private generation = 0;
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
	identityError?: string;
	lastError?: string;

	constructor(options: SoloMcpClientOptions = {}) {
		this.helperPath = options.helperPath ?? process.env.SOLO_MCP_HELPER ?? DEFAULT_SOLO_MCP_HELPER;
		this.appDataDir = options.appDataDir ?? process.env.SOLOTERM_APP_DATA_DIR ?? DEFAULT_SOLO_APP_DATA_DIR;
		const soloProcessId = options.soloProcessId ?? process.env.SOLO_PROCESS_ID;
		const parsedSoloProcessId = soloProcessId?.trim() ? Number(soloProcessId) : undefined;
		// Process IDs are positive integers. Invalid environment values are omitted
		// rather than allowing JSON.stringify to silently turn NaN into null.
		this.soloProcessId = Number.isSafeInteger(parsedSoloProcessId) && (parsedSoloProcessId ?? 0) > 0 ? parsedSoloProcessId : undefined;
		this.clientName = options.clientName ?? "pi-soloterm";
		this.clientVersion = options.clientVersion ?? "0.1.0";
		this.idleCloseMs = options.idleCloseMs ?? 5_000;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.diagnosticLimit = options.diagnosticLimit ?? 4_096;
		this.exists = options.exists ?? existsSync;
		this.spawnTransport = options.spawn ?? defaultSpawn;
		this.onStateChange = options.onStateChange;
	}

	async start(): Promise<void> {
		// stop() is also used when /soloterm is turned off. A later start must
		// revive the client rather than leaving it permanently stopped.
		this.stopped = false;
		if (!this.exists(this.helperPath)) {
			this.failState(`Solo MCP helper not found at ${this.helperPath}`);
			return;
		}
		await this.ensureChild();
		this.touchIdle();
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.failPending(new Error("Solo MCP client stopped"));
		this.killChild();
		this.ensurePromise = undefined;
		this.tools = [];
		this.serverInfo = undefined;
		this.identity = undefined;
		this.state = "stopped";
		this.emitState();
	}

	async restart(): Promise<void> {
		// Treat restart as a full generation boundary so queued calls from the old
		// transport cannot execute after the replacement is ready.
		this.stop();
		await this.start();
	}

	async refreshTools(): Promise<void> {
		try {
			await this.ensureChild();
			await this.loadTools();
			this.lastError = undefined;
			this.touchIdle();
		} catch (error) {
			const message = this.errorMessage(error);
			this.invalidateTransport(message);
			throw new Error(message);
		}
	}

	hasTool(name: string): boolean {
		return this.tools.some((tool) => tool.name === name);
	}

	canAttemptTool(name: string): boolean {
		return this.hasTool(name) || (!this.stopped && !this.child);
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

	async callTool(name: string, args: unknown = {}, signal?: AbortSignal): Promise<McpToolCallResult> {
		if (signal?.aborted) throw this.abortError(signal);
		if (this.stopped) throw new Error("Solo MCP client stopped");
		const enqueuedGeneration = this.generation;
		return this.enqueueCall(async () => {
			if (enqueuedGeneration !== this.generation) {
				throw new Error(`Solo MCP queued call '${name}' rejected because the client generation changed`);
			}
			if (signal?.aborted) throw this.abortError(signal);
			let active = true;
			let operationChild: SoloMcpTransport | undefined;
			const abort = () => {
				if (!active || !operationChild) return;
				this.invalidateTransport("Solo MCP request cancelled", true, operationChild);
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const ensuring = this.ensureChild();
				// ensureChild spawns synchronously before its first await. Retain that
				// exact transport so a late abort can never invalidate a newer one.
				operationChild = this.child;
				await ensuring;
				if (signal?.aborted) throw this.abortError(signal);
				operationChild = this.child;
				return await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
			} catch (error) {
				if (signal?.aborted) throw this.abortError(signal);
				throw error;
			} finally {
				active = false;
				signal?.removeEventListener("abort", abort);
				this.touchIdle();
			}
		});
	}

	private async ensureChild(): Promise<void> {
		if (this.stopped) throw new Error("Solo MCP client stopped");
		// A child exists before handshake/catalog loading completes. Authoritative
		// calls during warm-up must join startup rather than use the half-ready transport.
		if (this.ensurePromise) return this.ensurePromise;
		if (this.child) return;
		if (!this.exists(this.helperPath)) throw new Error(`Solo MCP helper not found at ${this.helperPath}`);

		this.state = "warming";
		this.lastError = undefined;
		this.emitState();

		const generation = this.generation;
		const ensurePromise = (async () => {
			try {
				this.spawnChild();
				await this.handshake();
				await this.loadTools();
				await this.identifySession();
				if (generation !== this.generation || this.stopped) throw new Error("Solo MCP client stopped");
				this.state = "ready";
				this.lastError = undefined;
				this.emitState();
			} catch (error) {
				if (generation === this.generation) {
					this.killChild();
					if (!this.stopped) this.failState(error instanceof Error ? error.message : String(error));
				}
				throw error;
			}
		})();
		this.ensurePromise = ensurePromise;
		try {
			await ensurePromise;
		} finally {
			if (this.ensurePromise === ensurePromise) this.ensurePromise = undefined;
		}
	}

	private spawnChild(): void {
		const env: NodeJS.ProcessEnv = { ...process.env, SOLOTERM_APP_DATA_DIR: this.appDataDir };
		delete env.SOLO_PROCESS_ID;
		if (this.soloProcessId !== undefined) env.SOLO_PROCESS_ID = String(this.soloProcessId);

		const child = this.spawnTransport(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"], env });
		this.child = child;
		this.buf = "";
		this.diagnostics = "";
		// Metadata belongs to one transport session and must never leak across reconnects.
		this.tools = [];
		this.serverInfo = undefined;
		this.identity = undefined;

		child.stdout.setEncoding?.("utf8");
		child.stdout.on("data", (chunk: Buffer | string) => this.handleStdout(String(chunk)));
		child.stderr.setEncoding?.("utf8");
		child.stderr.on("data", (chunk: Buffer | string) => this.appendDiagnostic(`stderr: ${String(chunk)}`));
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			const message = `Solo MCP helper exited (code=${code ?? "?"} signal=${signal ?? "?"})`;
			this.invalidateTransport(message, false);
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.invalidateTransport(`Solo MCP transport error: ${error.message}`, false);
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
			if (!message) {
				this.appendDiagnostic(`protocol: ${line}\n`);
				continue;
			}
			if (!("id" in message)) continue;
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
		this.identity = undefined;
		this.identityError = undefined;
		const name = this.hasTool("identify_session") ? "identify_session" : this.hasTool("whoami") ? "whoami" : undefined;
		if (!name) {
			this.identityError = "Solo MCP does not expose identify_session or whoami";
			return;
		}
		try {
			const args = name === "identify_session" && this.soloProcessId !== undefined ? { solo_process_id: this.soloProcessId } : {};
			const result = await this.request<McpToolCallResult>("tools/call", { name, arguments: args });
			if (soloToolResultIsError(result)) {
				this.identityError = mcpContentToText(result) || `${name} returned an error`;
				return;
			}
			this.identity = extractStructuredOrTextJson<SoloIdentity>(result);
			if (!this.identity) this.identityError = `${name} returned no usable session identity`;
		} catch (error) {
			this.identityError = error instanceof Error ? error.message : String(error);
		}
	}

	private request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("Solo MCP helper not running"));

		const id = this.nextId++;
		const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const message = `Solo MCP request '${method}' timed out after ${timeoutMs}ms`;
				reject(new Error(this.withDiagnostics(message)));
				this.invalidateTransport(message, true, child);
			}, timeoutMs);

			this.pending.set(id, {
				timer,
				resolve: (value) => resolve(value as T),
				reject,
			});

			try {
				child.stdin.write(`${JSON.stringify(payload)}\n`, (error?: Error | null) => {
					if (!error || !this.pending.has(id)) return;
					clearTimeout(timer);
					this.pending.delete(id);
					reject(error);
					this.invalidateTransport(`Solo MCP transport write failed: ${error.message}`, true, child);
				});
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				const failure = error instanceof Error ? error : new Error(String(error));
				reject(failure);
				this.invalidateTransport(`Solo MCP transport write failed: ${failure.message}`, true, child);
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

	private appendDiagnostic(text: string): void {
		this.diagnostics = (this.diagnostics + text).slice(-this.diagnosticLimit);
	}

	private withDiagnostics(message: string): string {
		const detail = this.diagnostics.trim();
		return detail ? `${message}; diagnostics: ${detail}` : message;
	}

	private errorMessage(error: unknown): string {
		return this.withDiagnostics(error instanceof Error ? error.message : String(error));
	}

	private abortError(signal: AbortSignal): Error {
		const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason == null ? "operation aborted" : String(signal.reason);
		const error = new Error(`Solo MCP request cancelled: ${reason}`);
		error.name = "AbortError";
		return error;
	}

	private invalidateTransport(message: string, kill = true, expectedChild?: SoloMcpTransport): void {
		if (expectedChild && this.child !== expectedChild) return;
		this.generation++;
		const error = new Error(this.withDiagnostics(message));
		this.failPending(error);
		if (kill) this.killChild();
		else this.child = undefined;
		this.buf = "";
		this.tools = [];
		this.serverInfo = undefined;
		this.identity = undefined;
		this.identityError = undefined;
		if (!this.stopped) this.failState(error.message);
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
