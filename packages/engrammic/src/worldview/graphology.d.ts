declare module "graphology" {
	export default class Graph {
		constructor(options?: { type?: string; multi?: boolean });
		order: number;
		size: number;
		hasNode(node: string): boolean;
		addNode(node: string): void;
		hasEdge(source: string, target: string): boolean;
		addEdge(source: string, target: string): void;
		neighbors(node: string): string[];
	}
}

declare module "graphology-pagerank" {
	import type Graph from "graphology";
	export default function pagerank(graph: Graph): Record<string, number>;
}
