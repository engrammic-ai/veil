export function getVeilUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `Veil/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
