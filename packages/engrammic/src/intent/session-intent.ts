import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntentNode, SessionIntent } from "./intent-types.ts";
import { generateIntentId } from "./project-intent.ts";

export interface SessionIntentManagerOptions {
	sessionId: string;
	projectRoot: string;
}

interface PersistedState {
	sessionId: string;
	intents: Record<string, SessionIntent>;
	createdAt: number;
	updatedAt: number;
}

export class SessionIntentManager {
	private intents = new Map<string, SessionIntent>();
	private sessionId: string;
	private projectRoot: string;
	private createdAt: number;

	constructor(options: SessionIntentManagerOptions) {
		this.sessionId = options.sessionId;
		this.projectRoot = options.projectRoot;
		this.createdAt = Date.now();
	}

	static async load(options: SessionIntentManagerOptions): Promise<SessionIntentManager> {
		const manager = new SessionIntentManager(options);
		const filePath = manager.filePath();

		try {
			const raw = await readFile(filePath, "utf-8");
			const state: PersistedState = JSON.parse(raw);
			manager.createdAt = state.createdAt;
			for (const intent of Object.values(state.intents)) {
				manager.intents.set(intent.id, intent);
			}
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				console.warn(`[SessionIntentManager] Could not load ${filePath}:`, (err as Error).message);
			}
		}

		return manager;
	}

	async save(): Promise<void> {
		const dir = join(this.projectRoot, ".veil", "session-intents");
		await mkdir(dir, { recursive: true });

		const state: PersistedState = {
			sessionId: this.sessionId,
			intents: Object.fromEntries(this.intents.entries()),
			createdAt: this.createdAt,
			updatedAt: Date.now(),
		};

		await writeFile(this.filePath(), JSON.stringify(state, null, 2), "utf-8");
	}

	createPrimary(
		content: string,
		opts?: { confidence?: "explicit" | "inferred"; source?: IntentNode["source"] },
	): SessionIntent {
		const intent: SessionIntent = {
			id: generateIntentId(),
			type: "primary",
			content,
			confidence: opts?.confidence ?? "inferred",
			source: opts?.source ?? "user",
			status: "active",
			createdAt: Date.now(),
			sessionId: this.sessionId,
		};
		this.intents.set(intent.id, intent);
		void this.save();
		return intent;
	}

	createSub(content: string, parentId: string, opts?: { status?: "active" | "pending" }): SessionIntent {
		const status = opts?.status ?? "pending";

		if (status === "active") {
			this.clearCurrentPointer();
		}

		const intent: SessionIntent = {
			id: generateIntentId(),
			type: "sub",
			content,
			confidence: "inferred",
			source: "user",
			status,
			createdAt: Date.now(),
			sessionId: this.sessionId,
			parent: parentId,
			current: status === "active" ? true : undefined,
		};
		this.intents.set(intent.id, intent);
		void this.save();
		return intent;
	}

	getPrimary(): SessionIntent | null {
		for (const intent of this.intents.values()) {
			if (intent.type === "primary") return intent;
		}
		return null;
	}

	getCurrent(): SessionIntent | null {
		for (const intent of this.intents.values()) {
			if (intent.current === true) return intent;
		}
		return null;
	}

	getSubIntents(parentId: string): SessionIntent[] {
		const result: SessionIntent[] = [];
		for (const intent of this.intents.values()) {
			if (intent.parent === parentId) result.push(intent);
		}
		return result;
	}

	complete(id: string): void {
		const intent = this.intents.get(id);
		if (!intent) return;

		const wasCurrent = intent.current === true;

		this.intents.set(id, {
			...intent,
			status: "completed",
			completedAt: Date.now(),
			current: undefined,
		});

		if (wasCurrent && intent.parent) {
			this.advanceCurrentToNextPending(intent.parent);
		}

		void this.save();
	}

	abandon(id: string): void {
		const intent = this.intents.get(id);
		if (!intent) return;

		this.intents.set(id, {
			...intent,
			status: "abandoned",
			current: undefined,
		});

		void this.save();
	}

	focus(id: string): void {
		if (!this.intents.has(id)) {
			throw new Error(`Intent not found: ${id}`);
		}
		this.clearCurrentPointer();
		const intent = this.intents.get(id)!;
		this.intents.set(id, { ...intent, current: true });
		void this.save();
	}

	getAll(): SessionIntent[] {
		return Array.from(this.intents.values());
	}

	async clear(): Promise<void> {
		this.intents.clear();
		await this.save();
	}

	private filePath(): string {
		return join(this.projectRoot, ".veil", "session-intents", `${this.sessionId}.json`);
	}

	private clearCurrentPointer(): void {
		for (const [id, intent] of this.intents.entries()) {
			if (intent.current === true) {
				this.intents.set(id, { ...intent, current: undefined });
			}
		}
	}

	private advanceCurrentToNextPending(parentId: string): void {
		const pending = Array.from(this.intents.values())
			.filter((i) => i.parent === parentId && i.status === "pending")
			.sort((a, b) => a.createdAt - b.createdAt);

		if (pending.length === 0) return;

		const next = pending[0];
		this.intents.set(next.id, { ...next, status: "active", current: true });
	}
}
