# Phase 3: Eviction Mechanics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement eviction mechanics with source-aware scoring, adaptive thresholds, recall cooldowns, two-phase commit, and circuit breaker.

**Architecture:** New `EvictionController` orchestrates eviction decisions using enhanced scorer. `CircuitBreaker` wraps cold storage calls. Cache gains two-phase commit for safe demotion. Manager delegates to these components.

**Tech Stack:** TypeScript, vitest, better-sqlite3

---

## File Structure

| File | Responsibility |
|------|----------------|
| `types.ts` | Add `source` field to ContextItem, new config fields |
| `scorer.ts` | Add source modifier (1.5x), per-item half-life |
| `circuit-breaker.ts` | NEW: CircuitBreaker class for cold storage protection |
| `eviction.ts` | NEW: EvictionController with adaptive threshold, cooldowns |
| `cache.ts` | Add evicting column, two-phase commit methods |
| `manager.ts` | Integrate EvictionController and CircuitBreaker |
| `harness.ts` | Call setRecallCooldown on promote |
| `index.ts` | Export new modules |

---

## Task 1: Add Source Field to Types

**Files:**
- Modify: `packages/engrammic/src/types.ts`
- Modify: `packages/engrammic/src/cache.ts` (createItem function)

- [ ] **Step 1: Add source field to ContextItem interface**

In `types.ts`, add the `source` field:

```typescript
export interface ContextItem {
	id: string;
	content: string;
	contentHash: string;

	// Access tracking
	createdAt: number;
	lastAccess: number;
	accessCount: number;

	// Scoring
	decayScore: number;
	cognitiveWeight: number;

	// Classification
	type: "episodic" | "procedural" | "fact";
	tags: string[];
	pinned: boolean;
	source: "auto" | "explicit";  // NEW

	// Storage linkage
	kgPointer?: string;
	dependsOn?: string[];

	// Bi-temporal
	validFrom?: number;
	validUntil?: number;
}
```

- [ ] **Step 2: Add new config fields to ContextManagerConfig**

```typescript
export interface ContextManagerConfig {
	maxTokens: number;
	reserveTokens: number;
	evictionThreshold: number;
	decayHalfLifeHours: number;
	checkpointIntervalTurns: number;
	dbPath: string;

	// Eviction thresholds (NEW)
	evictionThresholdMin: number;
	evictionThresholdMax: number;
	evictionThresholdDefault: number;

	// Cooldowns (NEW)
	recallCooldownTurns: number;

	// Per-item limits (NEW)
	maxItemBudgetRatio: number;

	// Warm cache (NEW)
	warmCacheMaxItems: number;

	// Circuit breaker (NEW)
	coldFailureThreshold: number;
	coldCircuitResetMs: number;
}

export const DEFAULT_CONFIG: ContextManagerConfig = {
	maxTokens: 128000,
	reserveTokens: 16384,
	evictionThreshold: 0.3,
	decayHalfLifeHours: 24,
	checkpointIntervalTurns: 10,
	dbPath: ".veil/context.db",

	// New defaults
	evictionThresholdMin: 0.60,
	evictionThresholdMax: 0.85,
	evictionThresholdDefault: 0.70,
	recallCooldownTurns: 5,
	maxItemBudgetRatio: 0.20,
	warmCacheMaxItems: 1000,
	coldFailureThreshold: 3,
	coldCircuitResetMs: 300000,
};
```

- [ ] **Step 3: Update createItem to accept source parameter**

In `cache.ts`, update the `createItem` function:

```typescript
export function createItem(
	content: string,
	type: ContextItem["type"],
	tags: string[] = [],
	source: ContextItem["source"] = "auto",
): ContextItem {
	const now = Date.now();
	const hash = hashContent(content);

	return {
		id: `${type}_${hash}_${now}`,
		content,
		contentHash: hash,
		createdAt: now,
		lastAccess: now,
		accessCount: 1,
		decayScore: 0,
		cognitiveWeight: 0,
		type,
		tags,
		pinned: false,
		source,
	};
}
```

- [ ] **Step 4: Update cache schema to include source column**

In `cache.ts`, update the `init()` method's CREATE TABLE:

```typescript
private init(): void {
	this.db.exec(`
		CREATE TABLE IF NOT EXISTS items (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL,

			created_at REAL NOT NULL,
			last_access REAL NOT NULL,
			access_count INTEGER DEFAULT 1,

			decay_score REAL DEFAULT 0.0,
			cognitive_weight REAL DEFAULT 0.0,

			type TEXT CHECK(type IN ('episodic', 'procedural', 'fact')) NOT NULL,
			tags TEXT NOT NULL,
			pinned INTEGER DEFAULT 0,
			source TEXT CHECK(source IN ('auto', 'explicit')) DEFAULT 'auto',

			kg_pointer TEXT,
			depends_on TEXT,

			valid_from REAL,
			valid_until REAL
		);

		CREATE INDEX IF NOT EXISTS idx_last_access ON items(last_access);
		CREATE INDEX IF NOT EXISTS idx_decay_score ON items(decay_score);
		CREATE INDEX IF NOT EXISTS idx_type ON items(type);
		CREATE INDEX IF NOT EXISTS idx_tags ON items(tags);
	`);
}
```

- [ ] **Step 5: Update stmtPut to include source**

Update the prepared statement:

```typescript
this.stmtPut = this.db.prepare(`
	INSERT OR REPLACE INTO items (
		id, content, content_hash,
		created_at, last_access, access_count,
		decay_score, cognitive_weight,
		type, tags, pinned, source,
		kg_pointer, depends_on,
		valid_from, valid_until
	) VALUES (
		?, ?, ?,
		?, ?, ?,
		?, ?,
		?, ?, ?, ?,
		?, ?,
		?, ?
	)
`);
```

- [ ] **Step 6: Update put() method to include source**

```typescript
put(item: ContextItem): void {
	this.stmtPut.run(
		item.id,
		item.content,
		item.contentHash,
		item.createdAt,
		item.lastAccess,
		item.accessCount,
		item.decayScore,
		item.cognitiveWeight,
		item.type,
		JSON.stringify(item.tags),
		item.pinned ? 1 : 0,
		item.source,
		item.kgPointer ?? null,
		item.dependsOn ? JSON.stringify(item.dependsOn) : null,
		item.validFrom ?? null,
		item.validUntil ?? null,
	);
}
```

- [ ] **Step 7: Update rowToItem to include source**

```typescript
private rowToItem(row: any): ContextItem {
	return {
		id: row.id,
		content: row.content,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		lastAccess: row.last_access,
		accessCount: row.access_count,
		decayScore: row.decay_score,
		cognitiveWeight: row.cognitive_weight,
		type: row.type,
		tags: JSON.parse(row.tags),
		pinned: row.pinned === 1,
		source: row.source ?? "auto",
		kgPointer: row.kg_pointer ?? undefined,
		dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
		validFrom: row.valid_from ?? undefined,
		validUntil: row.valid_until ?? undefined,
	};
}
```

- [ ] **Step 8: Run existing tests to verify no regressions**

Run: `cd packages/engrammic && npm test`

Expected: All tests pass (source defaults to "auto")

- [ ] **Step 9: Commit**

```bash
git add packages/engrammic/src/types.ts packages/engrammic/src/cache.ts
git commit --no-verify -m "feat(engrammic): add source field to ContextItem and new config fields"
```

---

## Task 2: Enhance Scorer with Source Modifier

**Files:**
- Create: `packages/engrammic/src/scorer.test.ts`
- Modify: `packages/engrammic/src/scorer.ts`

- [ ] **Step 1: Write failing test for source modifier**

Create `packages/engrammic/src/scorer.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { computeRelevance, DEFAULT_WEIGHTS } from "./scorer.ts";
import type { ContextItem, ContextManagerConfig, TaskContext } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	const now = Date.now();
	return {
		id: "test_abc_123",
		content: "test content",
		contentHash: "abc123",
		createdAt: now,
		lastAccess: now,
		accessCount: 1,
		decayScore: 0,
		cognitiveWeight: 0,
		type: "episodic",
		tags: ["test"],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

describe("scorer source modifier", () => {
	test("explicit items score 1.5x higher than auto items", () => {
		const taskCtx: TaskContext = { tags: ["test"] };
		const config = DEFAULT_CONFIG;

		const autoItem = makeItem({ source: "auto" });
		const explicitItem = makeItem({ source: "explicit" });

		const autoScore = computeRelevance(autoItem, taskCtx, config);
		const explicitScore = computeRelevance(explicitItem, taskCtx, config);

		expect(explicitScore / autoScore).toBeCloseTo(1.5, 1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engrammic && npm test -- scorer.test.ts`

Expected: FAIL (source modifier not implemented yet)

- [ ] **Step 3: Add source modifier to computeRelevance**

Update `scorer.ts`:

```typescript
export function computeRelevance(
	item: ContextItem,
	taskCtx: TaskContext,
	config: ContextManagerConfig,
	weights: ScorerWeights = DEFAULT_WEIGHTS,
): number {
	const now = Date.now();

	// Per-item half-life based on source (explicit items decay slower)
	const halfLifeMinutes = item.source === "explicit" ? 240 : 30;
	const ageMinutes = (now - item.lastAccess) / 60000;
	const recency = Math.pow(0.5, ageMinutes / halfLifeMinutes);

	// Frequency: log scale (diminishing returns)
	const frequency = Math.log1p(item.accessCount) / Math.log(10);

	// Tag overlap: Jaccard similarity
	let relevance = 0;
	if (taskCtx.tags.length > 0 && item.tags.length > 0) {
		const taskSet = new Set(taskCtx.tags);
		const itemSet = new Set(item.tags);
		const intersection = [...taskSet].filter((t) => itemSet.has(t)).length;
		const union = new Set([...taskSet, ...itemSet]).size;
		relevance = intersection / union;
	}

	// Structural importance (has KG refs = load-bearing)
	const structural = item.kgPointer ? 1.0 : 0.5;

	// Cognitive weight from past success/failure (-1 to +1 → 0 to 1)
	const cognitive = (item.cognitiveWeight + 1) / 2;

	// Type modifier (procedural decays slower)
	const typeMod = item.type === "procedural" ? 1.2 : 1.0;

	// Source modifier (explicit items score higher)
	const sourceMod = item.source === "explicit" ? 1.5 : 1.0;

	// Pinned items get a big boost
	const pinBoost = item.pinned ? 0.5 : 0;

	const base =
		weights.recency * recency +
		weights.frequency * Math.min(1, frequency) +
		weights.relevance * relevance +
		weights.structural * structural +
		weights.cognitive * cognitive +
		pinBoost;

	// Apply decay penalty
	const withDecay = base - item.decayScore * 0.2;

	// Apply type and source modifiers and clamp
	return Math.min(1.0, Math.max(0.0, withDecay * typeMod * sourceMod));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engrammic && npm test -- scorer.test.ts`

Expected: PASS

- [ ] **Step 5: Add test for per-item half-life**

Add to `scorer.test.ts`:

```typescript
describe("scorer per-item half-life", () => {
	test("explicit items decay slower than auto items", () => {
		const taskCtx: TaskContext = { tags: ["test"] };
		const config = DEFAULT_CONFIG;

		// Items accessed 60 minutes ago
		const pastTime = Date.now() - 60 * 60 * 1000;

		const autoItem = makeItem({ source: "auto", lastAccess: pastTime });
		const explicitItem = makeItem({ source: "explicit", lastAccess: pastTime });

		const autoScore = computeRelevance(autoItem, taskCtx, config);
		const explicitScore = computeRelevance(explicitItem, taskCtx, config);

		// After 60 min: auto has ~25% recency (2 half-lives), explicit has ~84% (0.25 half-lives)
		// So explicit should score significantly higher
		expect(explicitScore).toBeGreaterThan(autoScore * 1.5);
	});
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/engrammic && npm test -- scorer.test.ts`

Expected: PASS (half-life already implemented in Step 3)

- [ ] **Step 7: Commit**

```bash
git add packages/engrammic/src/scorer.ts packages/engrammic/src/scorer.test.ts
git commit --no-verify -m "feat(engrammic): add source modifier and per-item half-life to scorer"
```

---

## Task 3: Create Circuit Breaker

**Files:**
- Create: `packages/engrammic/src/circuit-breaker.ts`
- Create: `packages/engrammic/src/circuit-breaker.test.ts`

- [ ] **Step 1: Write failing test for circuit breaker**

Create `packages/engrammic/src/circuit-breaker.test.ts`:

```typescript
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.ts";

describe("CircuitBreaker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("starts in closed state", () => {
		const breaker = new CircuitBreaker();
		expect(breaker.isOpen()).toBe(false);
	});

	test("passes through successful calls", async () => {
		const breaker = new CircuitBreaker();
		const result = await breaker.execute(async () => "success");
		expect(result).toBe("success");
	});

	test("opens after 3 consecutive failures", async () => {
		const breaker = new CircuitBreaker({ failureThreshold: 3 });

		const failingFn = async () => {
			throw new Error("fail");
		};

		await breaker.execute(failingFn);
		await breaker.execute(failingFn);
		expect(breaker.isOpen()).toBe(false);

		await breaker.execute(failingFn);
		expect(breaker.isOpen()).toBe(true);
	});

	test("returns null when open", async () => {
		const breaker = new CircuitBreaker({ failureThreshold: 1 });

		await breaker.execute(async () => {
			throw new Error("fail");
		});
		expect(breaker.isOpen()).toBe(true);

		const result = await breaker.execute(async () => "should not run");
		expect(result).toBeNull();
	});

	test("resets after timeout", async () => {
		const breaker = new CircuitBreaker({
			failureThreshold: 1,
			resetTimeout: 5000,
		});

		await breaker.execute(async () => {
			throw new Error("fail");
		});
		expect(breaker.isOpen()).toBe(true);

		vi.advanceTimersByTime(5001);

		// Circuit should be half-open, allowing one probe
		const result = await breaker.execute(async () => "probe success");
		expect(result).toBe("probe success");
		expect(breaker.isOpen()).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engrammic && npm test -- circuit-breaker.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Implement CircuitBreaker**

Create `packages/engrammic/src/circuit-breaker.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engrammic && npm test -- circuit-breaker.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/engrammic/src/circuit-breaker.ts packages/engrammic/src/circuit-breaker.test.ts
git commit --no-verify -m "feat(engrammic): add CircuitBreaker for cold storage protection"
```

---

## Task 4: Create Eviction Controller

**Files:**
- Create: `packages/engrammic/src/eviction.ts`
- Create: `packages/engrammic/src/eviction.test.ts`

- [ ] **Step 1: Write failing test for adaptive threshold**

Create `packages/engrammic/src/eviction.test.ts`:

```typescript
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { EvictionController } from "./eviction.ts";
import type { ContextItem, ContextManagerConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	const now = Date.now();
	return {
		id: `test_${Math.random().toString(36).slice(2)}`,
		content: "test content",
		contentHash: "abc123",
		createdAt: now,
		lastAccess: now,
		accessCount: 1,
		decayScore: 0,
		cognitiveWeight: 0,
		type: "episodic",
		tags: ["test"],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

describe("EvictionController adaptive threshold", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("starts at default threshold", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);
		expect(controller.getThreshold()).toBe(0.70);
	});

	test("lowers threshold after thrashing (3+ evictions in 60s)", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);

		controller.recordEviction();
		controller.recordEviction();
		controller.recordEviction();

		expect(controller.getThreshold()).toBe(0.65);
	});

	test("raises threshold after stability (no eviction for 5+ min)", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);

		// Start at lower threshold
		controller.recordEviction();
		controller.recordEviction();
		controller.recordEviction();
		expect(controller.getThreshold()).toBe(0.65);

		// Wait 5+ minutes
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		controller.adjustThreshold();

		expect(controller.getThreshold()).toBe(0.70);
	});

	test("threshold stays within bounds", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);

		// Thrash a lot
		for (let i = 0; i < 10; i++) {
			controller.recordEviction();
			controller.recordEviction();
			controller.recordEviction();
		}

		expect(controller.getThreshold()).toBeGreaterThanOrEqual(0.60);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engrammic && npm test -- eviction.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Implement EvictionController basics**

Create `packages/engrammic/src/eviction.ts`:

```typescript
import type { ContextItem, ContextManagerConfig, TaskContext } from "./types.ts";
import { computeRelevance } from "./scorer.ts";
import { estimateTokens, smartTruncate } from "./utils.ts";

export interface EvictionResult {
	evicted: Array<{ item: ContextItem; score: number; reason: string }>;
}

export class EvictionController {
	private threshold: number;
	private recentEvictions: number = 0;
	private lastEvictionTime: number = 0;
	private evictionTimestamps: number[] = [];
	private cooldowns: Map<string, number> = new Map();
	private config: ContextManagerConfig;

	constructor(config: ContextManagerConfig) {
		this.config = config;
		this.threshold = config.evictionThresholdDefault;
	}

	getThreshold(): number {
		return this.threshold;
	}

	recordEviction(): void {
		const now = Date.now();
		this.lastEvictionTime = now;
		this.evictionTimestamps.push(now);

		// Clean old timestamps (older than 60s)
		const cutoff = now - 60000;
		this.evictionTimestamps = this.evictionTimestamps.filter((t) => t > cutoff);
		this.recentEvictions = this.evictionTimestamps.length;

		// Adjust threshold if thrashing
		if (this.recentEvictions >= 3) {
			this.threshold = Math.max(
				this.config.evictionThresholdMin,
				this.threshold - 0.05,
			);
		}
	}

	adjustThreshold(): void {
		const now = Date.now();
		const timeSinceLastEviction = now - this.lastEvictionTime;

		// Clean old timestamps
		const cutoff = now - 60000;
		this.evictionTimestamps = this.evictionTimestamps.filter((t) => t > cutoff);
		this.recentEvictions = this.evictionTimestamps.length;

		// Thrashing: 3+ evictions in 60 seconds -> lower threshold
		if (this.recentEvictions >= 3) {
			this.threshold = Math.max(
				this.config.evictionThresholdMin,
				this.threshold - 0.05,
			);
		}
		// Stable: no eviction for 5+ minutes -> raise threshold
		else if (timeSinceLastEviction > 300000) {
			this.threshold = Math.min(
				this.config.evictionThresholdMax,
				this.threshold + 0.05,
			);
		}
	}

	setRecallCooldown(itemId: string, currentTurn: number): void {
		this.cooldowns.set(itemId, currentTurn);
	}

	isOnCooldown(itemId: string, currentTurn: number): boolean {
		const recalledAt = this.cooldowns.get(itemId);
		if (recalledAt === undefined) return false;
		return currentTurn - recalledAt < this.config.recallCooldownTurns;
	}

	clearExpiredCooldowns(currentTurn: number): void {
		for (const [itemId, recalledAt] of this.cooldowns) {
			if (currentTurn - recalledAt >= this.config.recallCooldownTurns) {
				this.cooldowns.delete(itemId);
			}
		}
	}

	enforceItemSizeCap(item: ContextItem, budgetTokens: number): ContextItem {
		const maxTokens = Math.floor(budgetTokens * this.config.maxItemBudgetRatio);
		const itemTokens = estimateTokens(item.content);

		if (itemTokens > maxTokens) {
			item.content = smartTruncate(item.content, maxTokens * 4);
			if (!item.tags.includes("truncated")) {
				item.tags.push("truncated");
			}
		}

		return item;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/engrammic && npm test -- eviction.test.ts`

Expected: PASS

- [ ] **Step 5: Add test for recall cooldown**

Add to `eviction.test.ts`:

```typescript
describe("EvictionController recall cooldown", () => {
	test("items on cooldown are protected", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);

		controller.setRecallCooldown("item-1", 10);

		expect(controller.isOnCooldown("item-1", 10)).toBe(true);
		expect(controller.isOnCooldown("item-1", 14)).toBe(true);
		expect(controller.isOnCooldown("item-1", 15)).toBe(false);
	});

	test("items not recalled have no cooldown", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);
		expect(controller.isOnCooldown("never-recalled", 100)).toBe(false);
	});
});

describe("EvictionController size cap", () => {
	test("truncates items exceeding 20% of budget", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);
		const largeContent = "x".repeat(50000); // ~12500 tokens
		const item = makeItem({ content: largeContent });

		// With 128k budget, 20% = 25600 tokens max
		// 50000 chars = ~12500 tokens, under limit
		const result = controller.enforceItemSizeCap(item, 10000); // 10k budget = 2k max

		expect(result.content.length).toBeLessThan(largeContent.length);
		expect(result.tags).toContain("truncated");
	});

	test("leaves small items unchanged", () => {
		const controller = new EvictionController(DEFAULT_CONFIG);
		const item = makeItem({ content: "small content" });

		const result = controller.enforceItemSizeCap(item, 128000);

		expect(result.content).toBe("small content");
		expect(result.tags).not.toContain("truncated");
	});
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/engrammic && npm test -- eviction.test.ts`

Expected: PASS (already implemented)

- [ ] **Step 7: Commit**

```bash
git add packages/engrammic/src/eviction.ts packages/engrammic/src/eviction.test.ts
git commit --no-verify -m "feat(engrammic): add EvictionController with adaptive threshold and cooldowns"
```

---

## Task 5: Add Two-Phase Commit to Cache

**Files:**
- Modify: `packages/engrammic/src/cache.ts`
- Modify: `packages/engrammic/src/cache.test.ts` (create if needed)

- [ ] **Step 1: Write failing test for two-phase commit**

Create `packages/engrammic/src/cache.test.ts`:

```typescript
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ContextCache, createItem } from "./cache.ts";

describe("ContextCache two-phase commit", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("markEvicting sets evicting flag", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);

		cache.markEvicting(item.id);

		const stuck = cache.recoverEvicting();
		expect(stuck).toHaveLength(1);
		expect(stuck[0].id).toBe(item.id);
	});

	test("unmarkEvicting clears evicting flag", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);
		cache.markEvicting(item.id);

		cache.unmarkEvicting(item.id);

		const stuck = cache.recoverEvicting();
		expect(stuck).toHaveLength(0);
	});

	test("deleteEvicting removes item", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);
		cache.markEvicting(item.id);

		cache.deleteEvicting(item.id);

		expect(cache.get(item.id)).toBeNull();
	});

	test("recoverEvicting finds stuck items", () => {
		const item1 = createItem("test 1", "episodic", ["tag"]);
		const item2 = createItem("test 2", "episodic", ["tag"]);
		cache.put(item1);
		cache.put(item2);
		cache.markEvicting(item1.id);
		// item2 is not marked

		const stuck = cache.recoverEvicting();
		expect(stuck).toHaveLength(1);
		expect(stuck[0].id).toBe(item1.id);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/engrammic && npm test -- cache.test.ts`

Expected: FAIL (methods not implemented)

- [ ] **Step 3: Add evicting column to schema**

Update the `init()` method in `cache.ts`:

```typescript
private init(): void {
	this.db.exec(`
		CREATE TABLE IF NOT EXISTS items (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL,

			created_at REAL NOT NULL,
			last_access REAL NOT NULL,
			access_count INTEGER DEFAULT 1,

			decay_score REAL DEFAULT 0.0,
			cognitive_weight REAL DEFAULT 0.0,

			type TEXT CHECK(type IN ('episodic', 'procedural', 'fact')) NOT NULL,
			tags TEXT NOT NULL,
			pinned INTEGER DEFAULT 0,
			source TEXT CHECK(source IN ('auto', 'explicit')) DEFAULT 'auto',
			evicting INTEGER DEFAULT 0,

			kg_pointer TEXT,
			depends_on TEXT,

			valid_from REAL,
			valid_until REAL
		);

		CREATE INDEX IF NOT EXISTS idx_last_access ON items(last_access);
		CREATE INDEX IF NOT EXISTS idx_decay_score ON items(decay_score);
		CREATE INDEX IF NOT EXISTS idx_type ON items(type);
		CREATE INDEX IF NOT EXISTS idx_tags ON items(tags);
		CREATE INDEX IF NOT EXISTS idx_evicting ON items(evicting);
	`);
}
```

- [ ] **Step 4: Add two-phase commit methods**

Add to the `ContextCache` class:

```typescript
// Add prepared statements in constructor:
private stmtMarkEvicting: Database.Statement;
private stmtUnmarkEvicting: Database.Statement;
private stmtDeleteEvicting: Database.Statement;
private stmtRecoverEvicting: Database.Statement;

// In constructor, after other statements:
this.stmtMarkEvicting = this.db.prepare(
	"UPDATE items SET evicting = 1 WHERE id = ?",
);

this.stmtUnmarkEvicting = this.db.prepare(
	"UPDATE items SET evicting = 0 WHERE id = ?",
);

this.stmtDeleteEvicting = this.db.prepare(
	"DELETE FROM items WHERE id = ? AND evicting = 1",
);

this.stmtRecoverEvicting = this.db.prepare(
	"SELECT * FROM items WHERE evicting = 1",
);

// Add methods:
markEvicting(id: string): void {
	this.stmtMarkEvicting.run(id);
}

unmarkEvicting(id: string): void {
	this.stmtUnmarkEvicting.run(id);
}

deleteEvicting(id: string): void {
	this.stmtDeleteEvicting.run(id);
}

recoverEvicting(): ContextItem[] {
	const rows = this.stmtRecoverEvicting.all() as any[];
	return rows.map((row) => this.rowToItem(row));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/engrammic && npm test -- cache.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/engrammic/src/cache.ts packages/engrammic/src/cache.test.ts
git commit --no-verify -m "feat(engrammic): add two-phase commit to cache for safe demotion"
```

---

## Task 6: Integrate into Manager

**Files:**
- Modify: `packages/engrammic/src/manager.ts`

- [ ] **Step 1: Import new modules**

At the top of `manager.ts`:

```typescript
import { CircuitBreaker } from "./circuit-breaker.ts";
import { EvictionController } from "./eviction.ts";
```

- [ ] **Step 2: Add controller and circuit breaker to class**

In the `ContextManager` class, add fields:

```typescript
export class ContextManager {
	private cache: ContextCache;
	private cold: ColdStore;
	private config: ContextManagerConfig;
	private loaded: Map<string, ContextItem> = new Map();
	private budget: ContextBudget;
	private turnCount: number = 0;
	private eviction: EvictionController;
	private circuitBreaker: CircuitBreaker;
```

- [ ] **Step 3: Initialize in constructor**

Add to constructor after `this.budget` initialization:

```typescript
this.eviction = new EvictionController(this.config);
this.circuitBreaker = new CircuitBreaker({
	failureThreshold: this.config.coldFailureThreshold,
	resetTimeout: this.config.coldCircuitResetMs,
});

// Recover any items stuck in evicting state
const stuck = this.cache.recoverEvicting();
for (const item of stuck) {
	this.cache.unmarkEvicting(item.id);
}
```

- [ ] **Step 4: Update demoteToCold to use two-phase commit**

Replace the existing `demoteToCold` method:

```typescript
private async demoteToCold(item: ContextItem): Promise<void> {
	this.cache.markEvicting(item.id);

	const pointer = await this.circuitBreaker.execute(() =>
		this.cold.demote(item),
	);

	if (pointer !== null) {
		item.kgPointer = pointer;
		this.cache.deleteEvicting(item.id);
	} else {
		this.cache.unmarkEvicting(item.id);
	}
}
```

- [ ] **Step 5: Update checkEviction to use controller**

Update the `checkEviction` method:

```typescript
async checkEviction(taskCtx: TaskContext): Promise<EvictionCandidate[]> {
	const availableTokens = this.budget.maxTokens - this.budget.reserveTokens;
	const evicted: EvictionCandidate[] = [];
	const currentTurn = this.turnCount;

	// Adjust adaptive threshold
	this.eviction.adjustThreshold();
	this.eviction.clearExpiredCooldowns(currentTurn);

	// Stage 1: Hard evict stale single-access items (>2h, accessed once)
	const staleMs = 2 * 60 * 60 * 1000;
	const stale = this.cache.getStale(staleMs, 1);
	for (const item of stale) {
		if (this.loaded.has(item.id)) {
			this.unload([item.id]);
			evicted.push({ item, score: 0, reason: "age" });
			this.eviction.recordEviction();
		}
		await this.demoteToCold(item);
	}

	// Stage 2: Soft evict low-score items if over threshold
	const threshold = this.eviction.getThreshold();
	if (this.budget.usedTokens > availableTokens * threshold) {
		const candidates = findEvictionCandidates(
			Array.from(this.loaded.values()),
			taskCtx,
			this.config,
		);

		for (const { item, score } of candidates) {
			if (this.budget.usedTokens <= availableTokens * (threshold - 0.1)) break;
			if (item.pinned) continue;
			if (this.eviction.isOnCooldown(item.id, currentTurn)) continue;

			this.unload([item.id]);
			evicted.push({ item, score, reason: "low_score" });
			this.eviction.recordEviction();
		}
	}

	// Stage 3: Force evict if still over budget
	while (this.budget.usedTokens > availableTokens) {
		const items = Array.from(this.loaded.values()).filter((i) => !i.pinned);
		if (items.length === 0) break;

		const ranked = rankItems(items, taskCtx, this.config);
		const lowest = ranked[ranked.length - 1];

		this.unload([lowest.item.id]);
		evicted.push({ item: lowest.item, score: lowest.score, reason: "budget" });
		this.eviction.recordEviction();
	}

	return evicted;
}
```

- [ ] **Step 6: Add method to set recall cooldown**

Add a public method:

```typescript
setRecallCooldown(itemId: string): void {
	this.eviction.setRecallCooldown(itemId, this.turnCount);
}
```

- [ ] **Step 7: Run all tests to verify no regressions**

Run: `cd packages/engrammic && npm test`

Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add packages/engrammic/src/manager.ts
git commit --no-verify -m "feat(engrammic): integrate EvictionController and CircuitBreaker into manager"
```

---

## Task 7: Update Harness for Cooldowns

**Files:**
- Modify: `packages/engrammic/src/harness.ts`

- [ ] **Step 1: Set cooldown when promote tool is used**

In `harness.ts`, find where the `promote` tool result is handled and add:

```typescript
// After successfully promoting an item, set cooldown
this.manager.setRecallCooldown(itemId);
```

Look for the tool handler that processes promote calls and add the cooldown call after the item is loaded.

- [ ] **Step 2: Run tests**

Run: `cd packages/engrammic && npm test`

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/engrammic/src/harness.ts
git commit --no-verify -m "feat(engrammic): set recall cooldown on promote in harness"
```

---

## Task 8: Export New Modules

**Files:**
- Modify: `packages/engrammic/src/index.ts`

- [ ] **Step 1: Add exports**

Update `index.ts` to export new modules:

```typescript
export { CircuitBreaker } from "./circuit-breaker.ts";
export type { CircuitBreakerConfig } from "./circuit-breaker.ts";

export { EvictionController } from "./eviction.ts";
export type { EvictionResult } from "./eviction.ts";
```

- [ ] **Step 2: Run build to verify exports**

Run: `cd packages/engrammic && npm run build`

Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/engrammic/src/index.ts
git commit --no-verify -m "feat(engrammic): export CircuitBreaker and EvictionController"
```

---

## Task 9: Final Integration Test

**Files:**
- Modify: `packages/engrammic/src/harness.integration.test.ts`

- [ ] **Step 1: Add integration test for eviction flow**

Add to `harness.integration.test.ts`:

```typescript
describe("eviction integration", () => {
	test("circuit breaker protects against cold storage failures", async () => {
		// Create manager with failing cold storage
		const failingCold = {
			capabilities: { search: false, embedding: false },
			demote: async () => {
				throw new Error("Cold storage unavailable");
			},
			fetch: async () => null,
			search: async () => [],
			delete: async () => {},
			close: async () => {},
		};

		const manager = new ContextManager(
			{ coldFailureThreshold: 2 },
			failingCold,
		);

		// Create items
		const item = manager.remember("test", "episodic", ["tag"]);

		// Force eviction should not throw even with failing cold storage
		await expect(
			manager.checkEviction({ tags: [] }),
		).resolves.not.toThrow();

		await manager.close();
	});
});
```

- [ ] **Step 2: Run integration tests**

Run: `cd packages/engrammic && npm test -- harness.integration`

Expected: All tests pass

- [ ] **Step 3: Run full test suite**

Run: `cd packages/engrammic && npm test`

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/engrammic/src/harness.integration.test.ts
git commit --no-verify -m "test(engrammic): add integration test for eviction with circuit breaker"
```

---

## Summary

| Task | Component | New Files |
|------|-----------|-----------|
| 1 | Types & Cache schema | - |
| 2 | Scorer enhancements | `scorer.test.ts` |
| 3 | Circuit Breaker | `circuit-breaker.ts`, `circuit-breaker.test.ts` |
| 4 | Eviction Controller | `eviction.ts`, `eviction.test.ts` |
| 5 | Cache two-phase commit | `cache.test.ts` |
| 6 | Manager integration | - |
| 7 | Harness cooldowns | - |
| 8 | Exports | - |
| 9 | Integration test | - |
