/**
 * Failure detection for eviction mistakes.
 * Detects when users ask about evicted content, enabling threshold adjustment.
 */

// Patterns that indicate the user/agent is asking about evicted content
export const REREQUEST_PATTERNS = [
	/what did we decide/i,
	/earlier you said/i,
	/as I mentioned/i,
	/we already discussed/i,
	/remember when/i,
	/you said before/i,
];

export type EvictionFeedbackType = "rerequest" | "confusion";

export interface EvictionFeedback {
	type: EvictionFeedbackType;
	pattern: string;
	turnNumber: number;
	content: string;
}

/**
 * Detect if a message indicates we evicted something important.
 * Returns the first matching feedback or null.
 */
export function detectRerequest(message: string, turnNumber: number): EvictionFeedback | null {
	for (const pattern of REREQUEST_PATTERNS) {
		if (pattern.test(message)) {
			return {
				type: "rerequest",
				pattern: pattern.toString(),
				turnNumber,
				content: message,
			};
		}
	}
	return null;
}

export interface EvictionFeedbackTracker {
	record(feedback: EvictionFeedback): void;
	getRecentFeedback(limit?: number): EvictionFeedback[];
	// Returns suggested threshold adjustment in range [-1, 1]
	// Negative values suggest lowering the eviction threshold (keep more)
	suggestThresholdAdjustment(): number;
}

// Threshold below which feedback rate is acceptable (no adjustment needed)
const FEEDBACK_RATE_LOW = 0.05;
// Threshold above which we suggest a strong reduction
const FEEDBACK_RATE_HIGH = 0.2;

export function createEvictionFeedbackTracker(): EvictionFeedbackTracker {
	const feedback: EvictionFeedback[] = [];
	let totalTurns = 0;

	return {
		record(entry: EvictionFeedback): void {
			feedback.push(entry);
			// Track the highest turn number seen as a proxy for total turns
			if (entry.turnNumber > totalTurns) {
				totalTurns = entry.turnNumber;
			}
		},

		getRecentFeedback(limit = 10): EvictionFeedback[] {
			return feedback.slice(-limit);
		},

		suggestThresholdAdjustment(): number {
			if (feedback.length === 0 || totalTurns === 0) return 0;

			const rate = feedback.length / totalTurns;

			if (rate <= FEEDBACK_RATE_LOW) {
				// Acceptable rate - no adjustment
				return 0;
			}
			if (rate >= FEEDBACK_RATE_HIGH) {
				// High rerequest rate - suggest lowering threshold significantly
				return -1;
			}
			// Linear interpolation in the middle range
			const normalized = (rate - FEEDBACK_RATE_LOW) / (FEEDBACK_RATE_HIGH - FEEDBACK_RATE_LOW);
			return -normalized;
		},
	};
}
