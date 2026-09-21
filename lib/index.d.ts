export declare const name = 'web-search-opencode-style';
export declare const inject: string[];
export declare const PROVIDER_ID = 'opencode-style';
export declare const EXA_URL = 'https://mcp.exa.ai/mcp';
export declare const PARALLEL_URL = 'https://search.parallel.ai/mcp';
export declare const MAX_RESPONSE_BYTES: number;
/** Nguyên văn opencode trả khi search không ra kết quả. */
export declare const NO_RESULTS_TEXT = 'No search results found. Please try a different query.';
export declare const SETTINGS_NAMESPACE = 'web-search-opencode-style';
/** Schemastery schema cho row config + settings section; undefined khi không nạp được schemastery. */
export declare const Config: unknown;
export declare class WebError extends Error {
  code: string;
  constructor(message: string, code: string, options?: ErrorOptions);
}
export declare function checksum(content: string): string | undefined;
export declare function selectProvider(
  subject: string,
  cfg?: { provider?: string; enableExa?: boolean; enableParallel?: boolean },
): 'exa' | 'parallel';
export declare function parseMcpResponse(body: string): string | undefined;
export interface WebSearchSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}
/** Mọi source bóc được từ text provider, chưa cắt theo maxResults. */
export declare function extractAllSources(text: string): WebSearchSource[];
export declare function extractSources(text: string, maxResults?: number): WebSearchSource[];
export declare function sourcesFromParallelJson(text: string): WebSearchSource[] | undefined;
export declare function sourcesFromExaBlocks(text: string): WebSearchSource[] | undefined;
export declare function textToResult(text: string, maxResults?: number): { content?: string; sources: WebSearchSource[]; truncated: boolean };
export declare function callMcp(url: string, tool: string, args: Record<string, unknown>, opts?: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<string | undefined>;
export interface OpencodeStyleConfig {
  provider?: 'exa' | 'parallel' | string;
  /** Cờ như RuntimeFlags của opencode (env OPENCODE_ENABLE_EXA / …). */
  enableExa?: boolean;
  enableParallel?: boolean;
  exaApiKey?: string;
  parallelApiKey?: string;
  exaUrl?: string;
  parallelUrl?: string;
  type?: 'auto' | 'fast' | 'deep';
  livecrawl?: 'fallback' | 'preferred';
  contextMaxCharacters?: number;
  numResults?: number;
  timeoutMs?: number;
  enabled?: boolean;
}
export declare class OpencodeStyleSearchProvider {
  readonly id: string;
  constructor(
    resolveConfig: () => OpencodeStyleConfig,
    resolveAgent?: () => { modelName?: string; sessionId?: string },
  );
  available(): boolean;
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{ content?: string; sources: WebSearchSource[]; truncated: boolean }>;
}
export declare function apply(ctx: any, config?: OpencodeStyleConfig): void;
