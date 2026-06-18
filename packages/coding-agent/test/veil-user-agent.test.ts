import { describe, expect, it } from "vitest";
import { getVeilUserAgent } from "../src/utils/veil-user-agent.ts";

describe("getVeilUserAgent", () => {
	it("formats the user agent expected by veil", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getVeilUserAgent("1.2.3");

		expect(userAgent).toBe(`Veil/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^Veil\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
