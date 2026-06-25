/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { IpcClient, type ParentMessage } from "@veil/subagent";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../core/extensions/types.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { theme } from "./interactive/theme/theme.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** IPC socket path for parent communication (subagent mode) */
	veilIpc?: string;
}

/**
 * Create an IPC-based UI context for subagent permission prompts.
 * Routes confirmToolApproval through the IPC channel to parent.
 */
function createIpcUIContext(ipcClient: IpcClient): ExtensionUIContext {
	const pendingRequests = new Map<string, (result: "allow" | "deny" | "allow-session") => void>();

	// Handle responses from parent
	ipcClient.onMessage((msg: ParentMessage) => {
		if (msg.type === "permission_response") {
			const resolve = pendingRequests.get(msg.requestId);
			if (resolve) {
				pendingRequests.delete(msg.requestId);
				resolve(msg.result);
			}
		}
	});

	return {
		select: async () => undefined,
		confirm: async () => false,
		confirmToolApproval: async (toolName: string, message: string): Promise<"allow" | "deny" | "allow-session"> => {
			const requestId = crypto.randomUUID();
			return new Promise((resolve) => {
				pendingRequests.set(requestId, resolve);
				const sent = ipcClient.send({
					version: 1,
					type: "permission_request",
					requestId,
					toolName,
					message,
				});
				if (!sent) {
					pendingRequests.delete(requestId);
					resolve("deny");
				}
			});
		},
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		setToolCallDimmed: () => {},
	};
}

/**
 * Create a JSON stdin/stdout-based UI context for permission prompts.
 * Used when no IPC is available but we're in json mode.
 * Outputs permission_request events to stdout, reads responses from stdin.
 */
function createJsonUIContext(): ExtensionUIContext {
	const pendingRequests = new Map<string, (result: "allow" | "deny" | "allow-session") => void>();
	let stdinSetup = false;

	const setupStdinListener = () => {
		if (stdinSetup) return;
		stdinSetup = true;

		let buffer = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === "permission_response" && msg.requestId) {
						const resolve = pendingRequests.get(msg.requestId);
						if (resolve) {
							pendingRequests.delete(msg.requestId);
							resolve(msg.result || "deny");
						}
					}
				} catch {
					// Not JSON or not a permission response
				}
			}
		});
	};

	return {
		select: async () => undefined,
		confirm: async () => false,
		confirmToolApproval: async (toolName: string, message: string): Promise<"allow" | "deny" | "allow-session"> => {
			setupStdinListener();
			const requestId = crypto.randomUUID();

			return new Promise((resolve) => {
				pendingRequests.set(requestId, resolve);

				// Output permission request as JSON event
				writeRawStdout(
					JSON.stringify({
						type: "permission_request",
						requestId,
						toolName,
						message,
					}) + "\n",
				);

				// Timeout after 30s - parent must respond
				setTimeout(() => {
					if (pendingRequests.has(requestId)) {
						pendingRequests.delete(requestId);
						resolve("deny");
					}
				}, 30000);
			});
		},
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		setToolCallDimmed: () => {},
	};
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, veilIpc } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	// Connect IPC client for subagent permission routing
	let ipcClient: IpcClient | undefined;
	let uiContext: ExtensionUIContext | undefined;
	if (veilIpc) {
		ipcClient = new IpcClient(veilIpc);
		try {
			await ipcClient.connect();
			uiContext = createIpcUIContext(ipcClient);
		} catch {
			// ponytail: IPC connection failed, fall back to JSON mode
			ipcClient = undefined;
		}
	}

	// Fallback: use JSON stdin/stdout for permissions when in json mode
	if (!uiContext && mode === "json") {
		uiContext = createJsonUIContext();
	}

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		ipcClient?.close();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext,
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
