export class AliasTable {
	private readonly aliases: Map<string, string> = new Map();

	addAlias(variant: string, canonicalId: string): void {
		this.aliases.set(variant.toLowerCase(), canonicalId);
	}

	resolve(name: string): string | null {
		return this.aliases.get(name.toLowerCase()) ?? null;
	}

	removeAlias(variant: string): void {
		this.aliases.delete(variant.toLowerCase());
	}

	getAliases(): Array<{ variant: string; canonicalId: string }> {
		return [...this.aliases.entries()].map(([variant, canonicalId]) => ({ variant, canonicalId }));
	}

	get size(): number {
		return this.aliases.size;
	}
}
