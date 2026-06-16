/**
 * Code compression — wraps AST compression from worldview/ast-compress.
 *
 * Compresses functions to `signature [IMPL:hash]` format.
 * Falls back to original if parsing fails or no functions found.
 */

import { compressFile, type TreeSitterParser } from "../worldview/index.ts";

export interface CodeCompressOptions {
	preserveComments?: boolean;
}

/**
 * Compress code using AST-based compression.
 *
 * Returns original text if:
 * - No parser provided
 * - No file path (can't determine language)
 * - Parse fails
 * - No compressible functions found
 */
export async function compressCode(
	text: string,
	filePath?: string,
	parser?: TreeSitterParser,
	_options?: CodeCompressOptions,
): Promise<string> {
	if (!parser || !filePath) return text;

	try {
		return await compressFile(filePath, text, parser);
	} catch {
		return text;
	}
}
