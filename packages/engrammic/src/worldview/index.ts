export { compressFile, compressFunction, extractSignature, hashImplementation } from "./ast-compress.ts";
export type { FileMtimeRow } from "./file-tracker.ts";
export { FILE_MTIME_SCHEMA, FileTracker } from "./file-tracker.ts";
export type { RankRow } from "./graph-rank.ts";
export { buildFileGraph, computePageRank, RankStore, STRUCTURAL_RANK_SCHEMA, updateRanks } from "./graph-rank.ts";
export type { IncrementalUpdateResult } from "./incremental-update.ts";
export { checkAndUpdateFile } from "./incremental-update.ts";
export type { Tree, TreeSitterParserOptions } from "./parser.ts";
export {
	EXTENSION_MAP,
	getLanguageForFile,
	TreeSitterParser,
} from "./parser.ts";
export { getStructuralSuggestions } from "./structural-anticipate.ts";
export type { SymbolRow } from "./symbol-store.ts";
export { SYMBOL_GRAPH_SCHEMA, SymbolStore } from "./symbol-store.ts";
export type { ExtractedSymbol, SymbolKind } from "./symbols.ts";
export { extractFromTree, SymbolExtractor } from "./symbols.ts";

export type { ScoredSuggestion, UnifiedAnticipatorOptions } from "./unified-anticipate.ts";
export { UnifiedAnticipator } from "./unified-anticipate.ts";
