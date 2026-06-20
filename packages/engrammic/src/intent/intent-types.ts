export interface IntentNode {
	id: string;
	type: "primary" | "sub";
	content: string;

	confidence: "explicit" | "inferred";
	source: "user" | "brainstorm" | "plan" | "agent";

	status: "active" | "completed" | "abandoned";
	createdAt: number;
	completedAt?: number;

	supersedes?: string;

	parent?: string;

	current?: boolean;
}

export interface ProjectIntent {
	id: string;
	content: string;
	status: "active" | "completed" | "paused";
	createdAt: number;
	updatedAt: number;

	supersedes?: string;

	phases?: Array<{
		id: string;
		content: string;
		status: "completed" | "active" | "pending";
	}>;
}

export interface ProjectIntentFile {
	current: string | null;
	intents: Record<string, ProjectIntent>;
	history: string[];
}
