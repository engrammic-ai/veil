export interface EntityRef {
	/** Stable canonical ID — never use name as key */
	id: string;
	/** Display name */
	canonicalName: string;
	/** Alternative names/spellings that resolve to this entity */
	aliases: string[];
	/** Top co-occurring terms — primary disambiguation signal */
	fingerprint: string[];
	/** Known source URLs/repos for this entity */
	sources: string[];
	/** Optional distinguishing properties */
	properties?: Record<string, string>;
}

export const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"need",
	"dare",
	"ought",
	"used",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"also",
]);

export function extractFingerprint(content: string, limit = 10): string[] {
	const tokens = content.toLowerCase().split(/\W+/);
	const counts = new Map<string, number>();

	for (const token of tokens) {
		if (token.length > 3 && !STOPWORDS.has(token)) {
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
	}

	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([term]) => term);
}

export function fingerprintSimilarity(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	const intersection = [...setA].filter((x) => setB.has(x)).length;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}
