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
