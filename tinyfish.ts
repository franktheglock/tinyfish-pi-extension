import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * TinyFish web search + fetch tools for pi.
 * API: https://docs.tinyfish.ai/ (Search API, Fetch API)
 *
 * API key resolution order:
 *   1. TINYFISH_API_KEY environment variable
 *   2. ~/.pi/agent/tinyfish.json  { "apiKey": "..." }
 * Get a key at https://agent.tinyfish.ai/api-keys
 * Set it with:  /tinyfish key <KEY>   (persists to ~/.pi/agent/tinyfish.json)
 */

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const CONFIG_FILE = join(homedir(), ".pi", "agent", "tinyfish.json");

const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 130_000;

/** Max chars of extracted content kept per URL. */
const MAX_CONTENT_PER_URL = 30_000;
/** Max chars for the whole formatted tool result. */
const MAX_TOTAL_TEXT = 150_000;

interface TinyfishConfig {
  apiKey?: string;
}

async function loadConfig(): Promise<TinyfishConfig> {
  try {
    const data = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data) as TinyfishConfig;
  } catch {
    return {};
  }
}

async function getApiKey(): Promise<string | undefined> {
  const envKey = process.env.TINYFISH_API_KEY;
  if (envKey) return envKey;
  const config = await loadConfig();
  return config.apiKey || undefined;
}

/** Combine the pi abort signal with a hard timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${ms}ms`)), ms);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return controller.signal;
}

/** Run a fetch and return a friendly error message for common failures. */
async function request(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Request to ${url} failed: ${msg}`);
  }
}

async function parseError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string };
    if (typeof body.error === "string") detail = body.error;
    else if (body.error?.message) detail = body.error.message;
  } catch {
    /* keep empty */
  }
  const hint =
    res.status === 401
      ? " (check your TinyFish API key: /tinyfish key <KEY>)"
      : res.status === 429
        ? " (rate limited — retry later)"
        : res.status === 402
          ? " (credits needed — Search/Fetch are free, Agent/Browser use credits)"
          : "";
  return `TinyFish API error ${res.status}${hint}${detail ? `: ${detail}` : ""}`;
}

// ---------------------------------------------------------------------------
// tinyfish_search
// ---------------------------------------------------------------------------

const searchParamsSchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 2000, description: "Search query" }),
  purpose: Type.Optional(
    Type.String({
      maxLength: 2000,
      description: "Why this search is being run — the underlying goal or task the results will be used for. Helps rank results against your intent.",
    }),
  ),
  domain_type: Type.Optional(
    StringEnum(["web", "news", "research_paper"] as const, {
      description: 'Type of search: "web" for standard results, "news" for news articles, "research_paper" for academic papers. Defaults to "web".',
    }),
  ),
  location: Type.Optional(Type.String({ description: "Country code for geo-targeted results, e.g. US" })),
  language: Type.Optional(Type.String({ description: "Language code for result language, e.g. en" })),
  include_domains: Type.Optional(Type.String({ description: "Comma-separated list of domains to restrict results to, e.g. github.com,arxiv.org" })),
  exclude_domains: Type.Optional(Type.String({ description: "Comma-separated list of domains to exclude from results, e.g. pinterest.com,quora.com" })),
  after_date: Type.Optional(Type.String({ description: "Return results after this date (YYYY-MM-DD)" })),
  before_date: Type.Optional(Type.String({ description: "Return results before this date (YYYY-MM-DD)" })),
  recency_minutes: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 5_256_000, description: "Return results from the past N minutes" }),
  ),
  pub_year_min: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999, description: "Earliest publication year. Only for domain_type=research_paper." })),
  pub_year_max: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999, description: "Latest publication year. Only for domain_type=research_paper." })),
  page: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Page number for pagination, starting from 0 (max 10). Defaults to 0." })),
  include_thumbnail: Type.Optional(Type.Boolean({ description: "Include thumbnail_url on results when available. Defaults to false." })),
});

interface SearchResult {
  position: number;
  site_name: string;
  snippet: string;
  title: string;
  url: string;
  thumbnail_url?: string;
  date?: string;
  publisher?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  cited_by_count?: number;
  pdf_url?: string;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_results: number;
  page: number;
  request_id?: string;
}

function formatSearchResult(r: SearchResult): string {
  const lines: string[] = [];
  lines.push(`${r.position}. ${r.title}`);
  const meta: string[] = [];
  if (r.publisher) meta.push(r.publisher);
  if (r.date) meta.push(r.date);
  if (r.venue) meta.push(r.venue);
  if (r.year) meta.push(String(r.year));
  if (r.authors?.length) meta.push(`by ${r.authors.join(", ")}`);
  if (r.cited_by_count !== undefined) meta.push(`cited ${r.cited_by_count}x`);
  if (meta.length) lines.push(`   ${meta.join(" · ")}`);
  lines.push(`   ${r.site_name} — ${r.url}`);
  if (r.pdf_url) lines.push(`   PDF: ${r.pdf_url}`);
  if (r.snippet) lines.push(`   ${r.snippet.trim()}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// tinyfish_fetch
// ---------------------------------------------------------------------------

const fetchParamsSchema = Type.Object({
  urls: Type.Array(Type.String({ minLength: 1, format: "uri" }), {
    minItems: 1,
    maxItems: 10,
    description: "Array of URLs to fetch (1-10). Fetched in parallel; per-URL failures do not fail the whole request.",
  }),
  purpose: Type.Optional(
    Type.String({ maxLength: 2000, description: "Why these URLs are being fetched — the underlying goal or task the content will be used for." }),
  ),
  format: Type.Optional(
    StringEnum(["markdown", "html", "json"] as const, {
      description: 'Output format. "markdown" (default) is ideal for LLM consumption.',
    }),
  ),
  links: Type.Optional(Type.Boolean({ description: "Also extract all outbound links (<a href>) as absolute URLs. Defaults to false." })),
  image_links: Type.Optional(Type.Boolean({ description: "Also extract all image URLs (<img src>) as absolute URLs. Defaults to false." })),
  ttl: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Freshness tolerance in seconds for the cached entry. Omit for any cache age. 0 prefers a live fetch.",
    }),
  ),
  per_url_timeout_ms: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 110_000, description: "Wall-clock timeout budget in ms applied independently to each URL." }),
  ),
  include_selectors: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 20,
      description: "CSS selectors that scope extracted content to matching elements (e.g. [\"article\"]). Bypasses automatic boilerplate removal.",
    }),
  ),
  exclude_selectors: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 20,
      description: "CSS selectors for elements to remove before extraction (e.g. [\".comments\"]).",
    }),
  ),
});

interface FetchError {
  url: string;
  error: string;
  status?: number;
  message?: string;
}

interface FetchResult {
  url: string;
  final_url?: string | null;
  title?: string | null;
  description?: string | null;
  language?: string | null;
  format?: string;
  text?: string | Record<string, unknown> | null;
  links?: string[];
  image_links?: string[];
  author?: string | null;
  published_date?: string | null;
  unmatched_selectors?: string[];
}

interface FetchResponse {
  results: FetchResult[];
  errors: FetchError[];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated: showing ${max} of ${s.length} chars — fetch again with narrower selectors or per-URL targeting for more]`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tinyfish_search",
    label: "TinyFish Search",
    description:
      "Search the web and get structured ranked results (titles, snippets, URLs) via the TinyFish Search API. Supports news and research-paper searches, geo/language targeting, domain filtering, and date/recency windows. Use the purpose parameter to improve ranking. Follow up with tinyfish_fetch to read full page content.",
    promptSnippet: "tinyfish_search: search the web for up-to-date information (news, papers, docs, geo-targeted)",
    promptGuidelines: [
      "Use tinyfish_search when you need current information beyond your training data, then tinyfish_fetch to read the most relevant pages.",
      "Pass a purpose to tinyfish_search describing the underlying task so results are ranked against your intent.",
    ],
    parameters: searchParamsSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      const apiKey = await getApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "No TinyFish API key configured. Set it with /tinyfish key <KEY> (persists to ~/.pi/agent/tinyfish.json) or export TINYFISH_API_KEY. Get a key at https://agent.tinyfish.ai/api-keys",
            },
          ],
          isError: true,
        };
      }

      const qs = new URLSearchParams({ query: params.query });
      for (const [key, value] of Object.entries(params) as [string, unknown][]) {
        if (key === "query" || value === undefined) continue;
        qs.set(key, String(value));
      }

      onUpdate?.({ content: [{ type: "text", text: `Searching TinyFish: "${params.query}"…` }] });

      const res = await request(
        `${SEARCH_URL}/?${qs.toString()}`,
        {
          headers: { "X-API-Key": apiKey, Accept: "application/json" },
        },
        withTimeout(signal, SEARCH_TIMEOUT_MS),
      );

      if (!res.ok) {
        return { content: [{ type: "text", text: await parseError(res) }], isError: true };
      }

      const data = (await res.json()) as SearchResponse;
      const results = data.results ?? [];

      const lines: string[] = [];
      lines.push(`Search: "${data.query}" — ${data.total_results ?? results.length} results (page ${data.page ?? 0})`);
      if (params.purpose) lines.push(`Purpose: ${params.purpose}`);
      lines.push("");
      if (results.length === 0) {
        lines.push("No results.");
      } else {
        lines.push(results.map(formatSearchResult).join("\n\n"));
      }
      if (results.length > 0 && data.total_results > results.length) {
        lines.push("");
        lines.push(`Page ${(data.page ?? 0) + 1} of several — pass page=${(data.page ?? 0) + 1} to fetch more.`);
      }
      if (data.request_id) {
        lines.push("");
        lines.push(`request_id: ${data.request_id}`);
      }

      return {
        content: [{ type: "text", text: truncate(lines.join("\n"), MAX_TOTAL_TEXT) }],
        details: { query: data.query, totalResults: data.total_results, page: data.page, results },
      };
    },
  });

  pi.registerTool({
    name: "tinyfish_fetch",
    label: "TinyFish Fetch",
    description:
      "Fetch up to 10 URLs and extract clean page content (markdown by default) via the TinyFish Fetch API. Renders JavaScript-heavy pages when needed. Returns per-URL errors without failing the whole request. Use include_selectors to scope extraction (e.g. [\"article\"]).",
    promptSnippet: "tinyfish_fetch: fetch URLs and extract clean, readable page content as markdown",
    promptGuidelines: [
      "Use tinyfish_fetch to read the full content of pages found via tinyfish_search instead of guessing from snippets.",
      "Pass a purpose to tinyfish_fetch describing the task so extraction is tailored to your intent; use include_selectors when you only need part of a page.",
    ],
    parameters: fetchParamsSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      const apiKey = await getApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "No TinyFish API key configured. Set it with /tinyfish key <KEY> (persists to ~/.pi/agent/tinyfish.json) or export TINYFISH_API_KEY. Get a key at https://agent.tinyfish.ai/api-keys",
            },
          ],
          isError: true,
        };
      }

      const body: Record<string, unknown> = { urls: params.urls };
      for (const [key, value] of Object.entries(params) as [string, unknown][]) {
        if (key === "urls" || value === undefined) continue;
        body[key] = value;
      }

      onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.urls.length} URL(s) via TinyFish…` }] });

      const res = await request(
        FETCH_URL,
        {
          method: "POST",
          headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        },
        withTimeout(signal, FETCH_TIMEOUT_MS),
      );

      if (!res.ok) {
        return { content: [{ type: "text", text: await parseError(res) }], isError: true };
      }

      const data = (await res.json()) as FetchResponse;
      const parts: string[] = [];

      for (const r of data.results ?? []) {
        parts.push(`## ${r.url}`);
        const meta: string[] = [];
        if (r.final_url && r.final_url !== r.url) meta.push(`redirected from ${r.url}`);
        if (r.title) meta.push(`title: ${r.title}`);
        if (r.author) meta.push(`author: ${r.author}`);
        if (r.published_date) meta.push(`published: ${r.published_date}`);
        if (r.language) meta.push(`lang: ${r.language}`);
        if (r.description) meta.push(`description: ${r.description}`);
        if (meta.length) parts.push(meta.join("\n"));
        if (r.unmatched_selectors?.length) {
          parts.push(`note: selectors did not match: ${r.unmatched_selectors.join(", ")}`);
        }
        if (r.text != null) {
          const text = typeof r.text === "string" ? r.text : JSON.stringify(r.text, null, 2);
          parts.push(truncate(text, MAX_CONTENT_PER_URL));
        } else {
          parts.push("(no extractable content)");
        }
        if (r.links?.length) {
          parts.push(`links (${r.links.length}):`);
          parts.push(r.links.map((l) => `- ${l}`).join("\n"));
        }
        if (r.image_links?.length) {
          parts.push(`images (${r.image_links.length}):`);
          parts.push(r.image_links.map((l) => `- ${l}`).join("\n"));
        }
        parts.push("");
      }

      for (const e of data.errors ?? []) {
        parts.push(`## ERROR ${e.url}`);
        parts.push(`error: ${e.error}${e.status ? ` (HTTP ${e.status})` : ""}${e.message ? ` — ${e.message}` : ""}`);
        parts.push("");
      }

      if (parts.length === 0) {
        return {
          content: [{ type: "text", text: "TinyFish fetch returned no results or errors." }],
          details: { results: data.results ?? [], errors: data.errors ?? [] },
        };
      }

      return {
        content: [{ type: "text", text: truncate(parts.join("\n"), MAX_TOTAL_TEXT) }],
        details: { results: data.results ?? [], errors: data.errors ?? [] },
      };
    },
  });

  pi.registerCommand("tinyfish", {
    description:
      "Manage the TinyFish API key used by the tinyfish_search and tinyfish_fetch tools. Usage: /tinyfish (status) | /tinyfish key <KEY> | /tinyfish clear",
    handler: async (args, ctx) => {
      const argString = (args ?? "").trim();
      const envKey = process.env.TINYFISH_API_KEY;
      const config = await loadConfig();

      if (argString.startsWith("key ")) {
        const key = argString.slice(4).trim();
        if (!key) {
          ctx.ui.notify("Usage: /tinyfish key <KEY>", "error");
          return;
        }
        await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
        await writeFile(CONFIG_FILE, JSON.stringify({ ...config, apiKey: key }, null, 2));
        ctx.ui.notify("TinyFish API key saved to ~/.pi/agent/tinyfish.json", "success");
        return;
      }

      if (argString === "clear") {
        await writeFile(CONFIG_FILE, JSON.stringify({ ...config, apiKey: undefined }, null, 2));
        ctx.ui.notify("TinyFish API key removed from config (env var still applies if set)", "info");
        return;
      }

      if (argString !== "") {
        ctx.ui.notify("Usage: /tinyfish | /tinyfish key <KEY> | /tinyfish clear", "error");
        return;
      }

      const source = envKey ? "TINYFISH_API_KEY env var" : config.apiKey ? "~/.pi/agent/tinyfish.json" : null;
      ctx.ui.notify(
        source
          ? `TinyFish API key configured (${source})`
          : "No TinyFish API key configured. Run /tinyfish key <KEY> or export TINYFISH_API_KEY. Get a key at https://agent.tinyfish.ai/api-keys",
        source ? "success" : "error",
      );
    },
  });
}
