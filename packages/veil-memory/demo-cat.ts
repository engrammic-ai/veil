#!/usr/bin/env npx tsx
/**
 * Demo script for the cat widget - shows all states!
 * Run with: npx tsx packages/veil-memory/demo-cat.ts
 */

import { CatWidget } from "./src/ui/cat.ts";

const cat = new CatWidget({ mode: "unicode" });

const states = [
	{ state: "sleeping" as const, detail: "zzz..." },
	{ state: "watching" as const, detail: "observing session..." },
	{ state: "remembering" as const, detail: "storing observation..." },
	{ state: "learned" as const, detail: '"API uses OAuth2"' },
	{ state: "recalled" as const, detail: "found 3 memories" },
	{ state: "conflict" as const, detail: "competing beliefs detected!" },
];

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function demo() {
	console.clear();
	console.log("=== Veil Memory Cat Widget Demo ===\n");

	for (const s of states) {
		cat.setState(s);
		console.clear();
		console.log("=== Veil Memory Cat Widget Demo ===\n");
		console.log(cat.render());
		console.log("\n---");
		await sleep(1500);
	}

	console.clear();
	console.log("=== Veil Memory Cat Widget Demo ===\n");
	console.log(
		cat.renderSessionEnd({
			remembered: 12,
			learned: 5,
			recalled: 23,
			stabilityAvg: 4.2,
			conflicts: 1,
			evicted: 3,
		})
	);
	console.log("\n--- Session complete! ---\n");
}

demo();
