/**
 * Config/JSON compression — extract task-relevant keys only.
 *
 * Strategies:
 * 1. For arrays: keep first + last + count
 * 2. For deep objects: flatten to dotted paths with leaf values
 * 3. Truncate long string values
 * 4. Preserve structure indicators (type, kind, name, id, key fields)
 */

export interface ConfigCompressOptions {
	maxDepth?: number;
	maxStringLength?: number;
	maxArrayPreview?: number;
	preserveKeys?: string[];
}

const DEFAULT_OPTIONS: Required<ConfigCompressOptions> = {
	maxDepth: 4,
	maxStringLength: 100,
	maxArrayPreview: 3,
	preserveKeys: ["name", "id", "key", "type", "kind", "version", "path", "file", "command", "script", "main", "entry"],
};

/**
 * Compress JSON/config content by extracting structure and key values.
 */
export function compressConfig(text: string, options?: ConfigCompressOptions): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	const parsed = tryParseJson(text);
	if (parsed === null) {
		return compressYamlLike(text, opts);
	}

	return compressValue(parsed, opts, 0, "");
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function compressValue(value: unknown, opts: Required<ConfigCompressOptions>, depth: number, path: string): string {
	if (depth > opts.maxDepth) {
		return `${path ? `${path}: ` : ""}[...]`;
	}

	if (value === null) return `${path ? `${path}: ` : ""}null`;
	if (value === undefined) return `${path ? `${path}: ` : ""}undefined`;

	if (typeof value === "string") {
		const truncated = value.length > opts.maxStringLength ? `${value.slice(0, opts.maxStringLength)}...` : value;
		return `${path ? `${path}: ` : ""}"${truncated}"`;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return `${path ? `${path}: ` : ""}${value}`;
	}

	if (Array.isArray(value)) {
		return compressArray(value, opts, depth, path);
	}

	if (typeof value === "object") {
		return compressObject(value as Record<string, unknown>, opts, depth, path);
	}

	return `${path ? `${path}: ` : ""}${String(value)}`;
}

function compressArray(arr: unknown[], opts: Required<ConfigCompressOptions>, depth: number, path: string): string {
	if (arr.length === 0) return `${path ? `${path}: ` : ""}[]`;

	const lines: string[] = [];
	const prefix = path ? `${path}: ` : "";

	if (arr.length <= opts.maxArrayPreview * 2) {
		lines.push(`${prefix}[${arr.length} items]`);
		for (let i = 0; i < arr.length; i++) {
			lines.push(compressValue(arr[i], opts, depth + 1, `  [${i}]`));
		}
	} else {
		lines.push(`${prefix}[${arr.length} items]`);
		for (let i = 0; i < opts.maxArrayPreview; i++) {
			lines.push(compressValue(arr[i], opts, depth + 1, `  [${i}]`));
		}
		lines.push(`  ... ${arr.length - opts.maxArrayPreview * 2} more ...`);
		for (let i = arr.length - opts.maxArrayPreview; i < arr.length; i++) {
			lines.push(compressValue(arr[i], opts, depth + 1, `  [${i}]`));
		}
	}

	return lines.join("\n");
}

function compressObject(
	obj: Record<string, unknown>,
	opts: Required<ConfigCompressOptions>,
	depth: number,
	path: string,
): string {
	const keys = Object.keys(obj);
	if (keys.length === 0) return `${path ? `${path}: ` : ""}{}`;

	const lines: string[] = [];
	const indent = "  ".repeat(depth);

	const priorityKeys = keys.filter((k) => opts.preserveKeys.includes(k.toLowerCase()));
	const otherKeys = keys.filter((k) => !opts.preserveKeys.includes(k.toLowerCase()));

	for (const key of priorityKeys) {
		const newPath = path ? `${path}.${key}` : key;
		lines.push(indent + compressValue(obj[key], opts, depth + 1, newPath));
	}

	if (otherKeys.length <= 5) {
		for (const key of otherKeys) {
			const newPath = path ? `${path}.${key}` : key;
			lines.push(indent + compressValue(obj[key], opts, depth + 1, newPath));
		}
	} else {
		for (const key of otherKeys.slice(0, 3)) {
			const newPath = path ? `${path}.${key}` : key;
			lines.push(indent + compressValue(obj[key], opts, depth + 1, newPath));
		}
		lines.push(`${indent}... ${otherKeys.length - 3} more keys ...`);
	}

	return lines.join("\n");
}

function compressYamlLike(text: string, opts: Required<ConfigCompressOptions>): string {
	const lines = text.split("\n");
	if (lines.length <= 20) return text;

	const result: string[] = [];
	let _depth = 0;
	let skipUntilDepth = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		const indent = line.length - trimmed.length;
		const currentDepth = Math.floor(indent / 2);

		if (skipUntilDepth >= 0 && currentDepth > skipUntilDepth) {
			continue;
		}
		skipUntilDepth = -1;

		if (currentDepth > opts.maxDepth) {
			if (result[result.length - 1]?.includes("...")) continue;
			result.push(`${"  ".repeat(opts.maxDepth)}...`);
			skipUntilDepth = currentDepth - 1;
			continue;
		}

		const keyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
		if (keyMatch && opts.preserveKeys.includes(keyMatch[1].toLowerCase())) {
			result.push(line);
			_depth = currentDepth;
			continue;
		}

		if (result.length < 10 || lines.length - i <= 5) {
			result.push(line);
		} else if (!result[result.length - 1]?.includes("...")) {
			result.push(`${"  ".repeat(currentDepth)}... ${lines.length - result.length - 5} more lines ...`);
		}

		_depth = currentDepth;
	}

	return result.join("\n");
}
