/**
 * CircuitBreaker for protecting cold storage operations.
 *
 * When cold storage fails consecutively, the circuit opens and calls
 * return null instead of attempting the operation. After a timeout,
 * it allows a probe call to test if storage recovered.
 */

export interface CircuitBreakerConfig {
	failureThreshold: number;
	resetTimeout: number;
}

const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 3,
	resetTimeout: 300000, // 5 minutes
};

export class CircuitBreaker {
	private failures: number = 0;
	private open: boolean = false;
	private openedAt: number = 0;
	private config: CircuitBreakerConfig;

	constructor(config: Partial<CircuitBreakerConfig> = {}) {
		this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
	}

	isOpen(): boolean {
		if (!this.open) return false;
		// Check if reset timeout has passed (half-open state)
		const elapsed = Date.now() - this.openedAt;
		if (elapsed >= this.config.resetTimeout) {
			return false; // Allow probe
		}
		return true;
	}

	async execute<T>(fn: () => Promise<T>): Promise<T | null> {
		if (this.isOpen()) {
			return null;
		}
		try {
			const result = await fn();
			this.onSuccess();
			return result;
		} catch {
			this.onFailure();
			return null;
		}
	}

	reset(): void {
		this.failures = 0;
		this.open = false;
		this.openedAt = 0;
	}

	private onSuccess(): void {
		this.failures = 0;
		this.open = false;
		this.openedAt = 0;
	}

	private onFailure(): void {
		this.failures++;
		if (this.failures >= this.config.failureThreshold) {
			this.open = true;
			this.openedAt = Date.now();
		}
	}
}
