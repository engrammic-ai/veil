import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, MODEL_REGISTRY } from "./types.ts";

describe("MODEL_REGISTRY", () => {
	it("has all expected tiers", () => {
		expect(MODEL_REGISTRY.none).toBeNull();
		expect(MODEL_REGISTRY.light).toBeDefined();
		expect(MODEL_REGISTRY.balanced).toBeDefined();
		expect(MODEL_REGISTRY.quality).toBeDefined();
		expect(MODEL_REGISTRY.max).toBeDefined();
		expect(MODEL_REGISTRY.ollama).toBeDefined();
	});

	it("light tier has correct dimensions", () => {
		expect(MODEL_REGISTRY.light?.dimensions).toBe(384);
	});

	it("balanced tier has correct dimensions", () => {
		expect(MODEL_REGISTRY.balanced?.dimensions).toBe(384);
	});

	it("quality tier has correct dimensions", () => {
		expect(MODEL_REGISTRY.quality?.dimensions).toBe(768);
	});

	it("max tier has correct dimensions", () => {
		expect(MODEL_REGISTRY.max?.dimensions).toBe(1024);
	});

	it("ollama tier has correct dimensions", () => {
		expect(MODEL_REGISTRY.ollama?.dimensions).toBe(768);
	});
});

describe("DEFAULT_CONFIG", () => {
	it("has balanced as default tier", () => {
		expect(DEFAULT_CONFIG.tier).toBe("balanced");
	});

	it("has 3 hour idle timeout", () => {
		expect(DEFAULT_CONFIG.idleTimeoutMs).toBe(3 * 60 * 60 * 1000);
	});

	it("uses port 19532", () => {
		expect(DEFAULT_CONFIG.port).toBe(19532);
	});
});
