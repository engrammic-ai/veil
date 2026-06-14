/**
 * Unit tests for circuit-breaker.ts
 */

import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.ts";

describe("CircuitBreaker", () => {
	let breaker: CircuitBreaker;

	beforeEach(() => {
		vi.useFakeTimers();
		breaker = new CircuitBreaker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("starts in closed state", () => {
		expect(breaker.isOpen()).toBe(false);
	});

	test("passes through successful calls", async () => {
		const fn = vi.fn().mockResolvedValue("success");
		const result = await breaker.execute(fn);
		expect(result).toBe("success");
		expect(fn).toHaveBeenCalledOnce();
	});

	test("opens after 3 consecutive failures", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("test error"));

		// First failure
		const result1 = await breaker.execute(fn);
		expect(result1).toBeNull();
		expect(breaker.isOpen()).toBe(false);

		// Second failure
		const result2 = await breaker.execute(fn);
		expect(result2).toBeNull();
		expect(breaker.isOpen()).toBe(false);

		// Third failure opens the circuit
		const result3 = await breaker.execute(fn);
		expect(result3).toBeNull();
		expect(breaker.isOpen()).toBe(true);
	});

	test("returns null when open", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("test error"));

		// Trigger 3 failures to open the circuit
		await breaker.execute(fn);
		await breaker.execute(fn);
		await breaker.execute(fn);

		expect(breaker.isOpen()).toBe(true);

		// Reset mock to track new calls
		fn.mockClear();

		// Subsequent calls should not execute fn
		const result = await breaker.execute(fn);
		expect(result).toBeNull();
		expect(fn).not.toHaveBeenCalled();
	});

	test("resets after timeout", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("test error"));

		// Trigger 3 failures to open the circuit
		await breaker.execute(fn);
		await breaker.execute(fn);
		await breaker.execute(fn);

		expect(breaker.isOpen()).toBe(true);

		// Advance time past the reset timeout (5 minutes)
		vi.advanceTimersByTime(300001);

		// Circuit should allow a probe
		expect(breaker.isOpen()).toBe(false);
	});

	test("can reset manually", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("test error"));

		// Trigger 3 failures to open the circuit
		await breaker.execute(fn);
		await breaker.execute(fn);
		await breaker.execute(fn);

		expect(breaker.isOpen()).toBe(true);

		// Manual reset
		breaker.reset();

		expect(breaker.isOpen()).toBe(false);
		expect(fn.mock.calls.length).toBe(3);

		// Clear mock and make a new successful call
		fn.mockClear();
		fn.mockResolvedValue("success");
		const result = await breaker.execute(fn);
		expect(result).toBe("success");
		expect(fn).toHaveBeenCalledOnce();
	});

	test("resets failure count on success", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error("fail1"))
			.mockRejectedValueOnce(new Error("fail2"))
			.mockResolvedValueOnce("success")
			.mockRejectedValueOnce(new Error("fail3"))
			.mockRejectedValueOnce(new Error("fail4"));

		// Two failures
		await breaker.execute(fn);
		await breaker.execute(fn);

		// Success resets the count
		const result = await breaker.execute(fn);
		expect(result).toBe("success");
		expect(breaker.isOpen()).toBe(false);

		// Two more failures (not three) should not open the circuit
		await breaker.execute(fn);
		await breaker.execute(fn);

		expect(breaker.isOpen()).toBe(false);
	});

	test("accepts custom config", async () => {
		const customBreaker = new CircuitBreaker({
			failureThreshold: 2,
			resetTimeout: 100000,
		});

		const fn = vi.fn().mockRejectedValue(new Error("test error"));

		// Two failures should open with custom threshold
		await customBreaker.execute(fn);
		expect(customBreaker.isOpen()).toBe(false);

		await customBreaker.execute(fn);
		expect(customBreaker.isOpen()).toBe(true);
	});

	test("allows probe after timeout with custom resetTimeout", async () => {
		const customBreaker = new CircuitBreaker({
			failureThreshold: 2,
			resetTimeout: 100000,
		});

		const fn = vi.fn().mockRejectedValue(new Error("test error"));

		// Two failures to open
		await customBreaker.execute(fn);
		await customBreaker.execute(fn);

		expect(customBreaker.isOpen()).toBe(true);

		// Advance time past custom timeout
		vi.advanceTimersByTime(100001);

		expect(customBreaker.isOpen()).toBe(false);
	});

	test("each successful call keeps circuit closed", async () => {
		let callCount = 0;
		const fn = vi.fn().mockImplementation(async () => {
			callCount++;
			return `result${callCount}`;
		});

		const result1 = await breaker.execute(fn);
		expect(result1).toBe("result1");
		expect(breaker.isOpen()).toBe(false);

		const result2 = await breaker.execute(fn);
		expect(result2).toBe("result2");
		expect(breaker.isOpen()).toBe(false);

		const result3 = await breaker.execute(fn);
		expect(result3).toBe("result3");
		expect(breaker.isOpen()).toBe(false);
	});
});
