import { ok, type Result } from "./result.ts";
import type { SearchProviderName, SearchQuery, SearchRecency } from "./types.ts";
import type { NormalizedSearchResult, SearchProvider, SearchProviderError } from "./providers/types.ts";

export interface SearchWebInput {
	readonly query: SearchQuery;
	readonly maxResults: number;
	readonly recency: SearchRecency;
}

export interface SearchWebResult {
	readonly query: SearchQuery;
	readonly recency: SearchRecency;
	readonly maxResults: number;
	readonly provider: SearchProviderName;
	readonly results: readonly NormalizedSearchResult[];
}

export type SearchWebError = SearchProviderError;

export class SearchWeb {
	constructor(private readonly dependencies: { readonly provider: SearchProvider }) {}

	/** Execute a web search through the configured provider. */
	async search(
		input: SearchWebInput,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<Result<SearchWebResult, SearchWebError>> {
		const providerResult = await this.dependencies.provider.search(input, { signal: options.signal });
		if (providerResult._tag === "err") {
			return providerResult;
		}

		return ok({
			query: input.query,
			recency: input.recency,
			maxResults: input.maxResults,
			provider: this.dependencies.provider.name,
			results: providerResult.value,
		});
	}
}
