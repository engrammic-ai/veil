/**
 * Version vector logic for causal ordering.
 *
 * If V1 dominates V2 -> V1 causally follows V2 (supersession)
 * If neither dominates -> concurrent writes (conflict)
 */

import type { VersionVector } from "./types.ts";

export function dominates(v1: VersionVector, v2: VersionVector): boolean {
	let dominated = true;
	let strict = false;

	const allKeys = new Set([...Object.keys(v1), ...Object.keys(v2)]);

	for (const key of allKeys) {
		const val1 = v1[key] ?? 0;
		const val2 = v2[key] ?? 0;

		if (val1 < val2) dominated = false;
		if (val1 > val2) strict = true;
	}

	return dominated && strict;
}

export function merge(v1: VersionVector, v2: VersionVector): VersionVector {
	const result: VersionVector = { ...v1 };
	for (const [key, val] of Object.entries(v2)) {
		result[key] = Math.max(result[key] ?? 0, val);
	}
	return result;
}

export function increment(v: VersionVector, agentId: string): VersionVector {
	return { ...v, [agentId]: (v[agentId] ?? 0) + 1 };
}

export function areConcurrent(v1: VersionVector, v2: VersionVector): boolean {
	return !dominates(v1, v2) && !dominates(v2, v1);
}

export function isEmpty(v: VersionVector): boolean {
	return Object.keys(v).length === 0;
}

export function compare(v1: VersionVector, v2: VersionVector): -1 | 0 | 1 {
	if (dominates(v1, v2)) return 1;
	if (dominates(v2, v1)) return -1;
	return 0;
}
