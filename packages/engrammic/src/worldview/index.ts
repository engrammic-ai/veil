export type { Tree, TreeSitterParserOptions } from "./parser.ts";
export {
	EXTENSION_MAP,
	getLanguageForFile,
	TreeSitterParser,
} from "./parser.ts";

export type { ExtractedSymbol, SymbolKind } from "./symbols.ts";
export { SymbolExtractor, extractFromTree } from "./symbols.ts";

export type { SymbolRow } from "./symbol-store.ts";
export { SymbolStore, SYMBOL_GRAPH_SCHEMA } from "./symbol-store.ts";

export type { FileMtimeRow } from "./file-tracker.ts";
export { FileTracker, FILE_MTIME_SCHEMA } from "./file-tracker.ts";

export type { IncrementalUpdateResult } from "./incremental-update.ts";
export { checkAndUpdateFile } from "./incremental-update.ts";

export { hashImplementation, extractSignature, compressFunction, compressFile } from "./ast-compress.ts";

export type { RankRow } from "./graph-rank.ts";
export { STRUCTURAL_RANK_SCHEMA, buildFileGraph, computePageRank, RankStore, updateRanks } from "./graph-rank.ts";

export { getStructuralSuggestions } from "./structural-anticipate.ts";

export type { ScoredSuggestion, UnifiedAnticipatorOptions } from "./unified-anticipate.ts";
export { UnifiedAnticipator } from "./unified-anticipate.ts";
