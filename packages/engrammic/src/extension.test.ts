import { beforeEach, describe, expect, test, vi } from "vitest";
import { createVeilExtension } from "./extension.ts";
import type { VeilHarness } from "./harness.ts";

// ---- helpers ----------------------------------------------------------------

function makeHarness(
	overrides: Partial<ReturnType<VeilHarness["getUsage"]>> = {},
	processUserMessageResult: string | null = null,
): VeilHarness {
	const defaults = {
		hotTokens: 2000,
		hotItems: 5,
		budgetMax: 8000,
		budgetUsed: 2000,
		budgetReserve: 0,
		percent: 25,
	};
	return {
		getUsage: vi.fn(() => ({ ...defaults, ...overrides })),
		getTurnCount: vi.fn(() => 3),
		getAndClearEvictedToolCallIds: vi.fn(() => []),
		processUserMessage: vi.fn(async () => processUserMessageResult),
		onMemoryEvent: vi.fn(() => () => {}),
		getCatWidget: vi.fn(() => ({ getState: () => ({ state: "watching" }) })),
	} as unknown as VeilHarness;
}

interface MockPi {
	handlers: Map<string, (event: unknown, ctx: MockCtx) => Promise<void>>;
	flags: Map<string, boolean | string>;
	on: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
}

interface MockCtx {
	ui: {
		setStatus: ReturnType<typeof vi.fn>;
		setToolCallDimmed: ReturnType<typeof vi.fn>;
		theme: {
			fg: (color: string, text: string) => string;
		};
	};
}

function makePi(flagValues: Record<string, boolean | string> = {}): MockPi {
	const handlers = new Map<string, (event: unknown, ctx: MockCtx) => Promise<void>>();
	const flags = new Map(Object.entries(flagValues));

	return {
		handlers,
		flags,
		on: vi.fn((event: string, handler: (event: unknown, ctx: MockCtx) => Promise<void>) => {
			handlers.set(event, handler);
		}),
		registerFlag: vi.fn(),
		getFlag: vi.fn((name: string) => flags.get(name)),
	};
}

function makeCtx(): MockCtx {
	return {
		ui: {
			setStatus: vi.fn(),
			setToolCallDimmed: vi.fn(),
			theme: {
				fg: (color: string, text: string) => `[${color}]${text}`,
			},
		},
	};
}

// ---- tests ------------------------------------------------------------------

describe("createVeilExtension", () => {
	let harness: VeilHarness;
	let pi: MockPi;
	let ctx: MockCtx;

	beforeEach(() => {
		harness = makeHarness();
		pi = makePi();
		ctx = makeCtx();
	});

	test("registers --debug-tick flag on initialisation", () => {
		const ext = createVeilExtension(harness);
		ext(pi as never);

		expect(pi.registerFlag).toHaveBeenCalledWith("debug-tick", {
			description: expect.any(String),
			type: "boolean",
			default: false,
		});
	});

	test("subscribes to turn_end event", () => {
		const ext = createVeilExtension(harness);
		ext(pi as never);

		expect(pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	test("subscribes to before_agent_start event", () => {
		const ext = createVeilExtension(harness);
		ext(pi as never);

		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	test("appends manifest to system prompt when triggers match", async () => {
		const manifest = "<veil-available>\nTest manifest\n</veil-available>";
		harness = makeHarness({}, manifest);
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("before_agent_start")!;
		const event = { prompt: "fix the tests", systemPrompt: "Base prompt" };
		const result = await handler(event, ctx);

		expect(harness.processUserMessage).toHaveBeenCalledWith("fix the tests");
		expect(result).toEqual({ systemPrompt: `Base prompt\n\n${manifest}` });
	});

	test("returns undefined when no triggers match", async () => {
		harness = makeHarness({}, null);
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("before_agent_start")!;
		const event = { prompt: "hello world", systemPrompt: "Base prompt" };
		const result = await handler(event, ctx);

		expect(result).toBeUndefined();
	});

	test("sets veil-context status on turn_end", async () => {
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("veil-context", expect.any(String));
	});

	test("status text contains formatted token counts", async () => {
		harness = makeHarness({ hotTokens: 2100, budgetMax: 8000, budgetReserve: 0 });
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		const [, text] = ctx.ui.setStatus.mock.calls.find(([key]) => key === "veil-context")!;
		expect(text).toContain("2.1k");
		expect(text).toContain("8k");
	});

	test("applies health color via theme.fg", async () => {
		// 2000/8000 = 25% → success color
		harness = makeHarness({ hotTokens: 2000, budgetMax: 8000, budgetReserve: 0 });
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		const [, text] = ctx.ui.setStatus.mock.calls.find(([key]) => key === "veil-context")!;
		expect(text).toContain("[success]");
	});

	test("does not set veil-tick when debug-tick flag is off (default)", async () => {
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		// veil-tick should be cleared (set to undefined)
		const tickCall = ctx.ui.setStatus.mock.calls.find(([key]) => key === "veil-tick");
		expect(tickCall).toBeDefined();
		expect(tickCall![1]).toBeUndefined();
	});

	test("shows tick count when --debug-tick flag is set", async () => {
		pi = makePi({ "debug-tick": true });
		ctx = makeCtx();

		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		const tickCall = ctx.ui.setStatus.mock.calls.find(([key]) => key === "veil-tick");
		expect(tickCall).toBeDefined();
		expect(tickCall![1]).toContain("tick:3");
	});

	test("calls harness.getUsage() on every turn_end", async () => {
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);
		await handler({}, ctx);

		expect(harness.getUsage).toHaveBeenCalledTimes(2);
	});

	test("reflects reserve tokens in available budget display", async () => {
		// 2000 used / (8000 max - 2000 reserve) = 33% → success
		harness = makeHarness({ hotTokens: 2000, budgetMax: 8000, budgetReserve: 2000 });
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		const [, text] = ctx.ui.setStatus.mock.calls.find(([key]) => key === "veil-context")!;
		// available = 8000 - 2000 = 6000 → "6k"
		expect(text).toContain("6k");
	});

	test("color escalates to warning near budget boundary", async () => {
		// 3500 / (8000 - 2000) = 58% → warning
		harness = makeHarness({ hotTokens: 3500, budgetMax: 8000, budgetReserve: 2000 });
		const ext = createVeilExtension(harness);
		ext(pi as never);

		const handler = pi.handlers.get("turn_end")!;
		await handler({}, ctx);

		const [, text] = ctx.ui.setStatus.mock.calls.find(([key]) => key === "veil-context")!;
		expect(text).toContain("[warning]");
	});
});
