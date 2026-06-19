/**
 * Extractors module - transforms raw tool output into compact memory captures.
 */

export { bashExtractor } from "./bash.ts";
// Export extractors
export { editExtractor } from "./edit.ts";
export { readExtractor } from "./read.ts";
// Export registry
export { getExtractor } from "./registry.ts";
// Export types
export type { EnhancedCaptureRule, Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
// Export utilities
export { extractDomain, extractExtension, isCodeExtension, truncate, truncateCmd } from "./utils.ts";
