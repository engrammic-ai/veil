/**
 * Compression pipeline — content-type detection + per-type compressors.
 */

export { type CodeCompressOptions, compressCode } from "./code-compress.ts";
export { type ConfigCompressOptions, compressConfig } from "./config-compress.ts";
export { type ContentMetadata, type ContentType, detectContentType } from "./content-type.ts";
export { type ConversationCompressOptions, compressConversation } from "./conversation-compress.ts";
export { type CompressionResult, type CompressOptions, compress, compressSync } from "./dispatcher.ts";
