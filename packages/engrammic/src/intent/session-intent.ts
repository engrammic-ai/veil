import type { IntentNode, SessionIntent } from "./intent-types.ts";
import { generateIntentId } from "./project-intent.ts";

export class SessionIntentManager {
	private intents = new Map<string, SessionIntent>();
	private sessionId: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
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
	}

	abandon(id: string): void {
		const intent = this.intents.get(id);
		if (!intent) return;

		const wasCurrent = intent.current === true;

		this.intents.set(id, {
			...intent,
			status: "abandoned",
			current: undefined,
		});

		// Brief requires abandon does NOT advance current, just clears it if abandoned was current
		if (wasCurrent) {
			// current already cleared above — no advance
		}
	}

	focus(id: string): void {
		if (!this.intents.has(id)) {
			throw new Error(`Intent not found: ${id}`);
		}
		this.clearCurrentPointer();
		const intent = this.intents.get(id)!;
		this.intents.set(id, { ...intent, current: true });
	}

	getAll(): SessionIntent[] {
		return Array.from(this.intents.values());
	}

	clear(): void {
		this.intents.clear();
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
