import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "./types.js";

const DEFAULT_MAX_RESULTS = 10;
const HARD_MAX_RESULTS = 20;
const REQUEST_TIMEOUT_MS = 20_000;

export type WebSearchProvider =
  | "brave"
  | "serper"
  | "tavily"
  | "google"
  | "duckduckgo";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  provider: WebSearchProvider;
}

interface ProviderConfig {
  provider: Exclude<WebSearchProvider, "duckduckgo">;
  apiKey: string;
  cx?: string;
}

interface Args {
  query: string;
  max_results?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("web_search: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["query"] !== "string" || obj["query"].trim().length === 0) {
    throw new Error("web_search: 'query' must be a non-empty string");
  }
  const args: Args = { query: obj["query"].trim() };
  if (obj["max_results"] !== undefined) {
    if (typeof obj["max_results"] !== "number" || obj["max_results"] <= 0) {
      throw new Error("web_search: 'max_results' must be a positive number");
    }
    args.max_results = Math.min(
      Math.floor(obj["max_results"]),
      HARD_MAX_RESULTS,
    );
  }
  if (obj["allowed_domains"] !== undefined) {
    if (
      !Array.isArray(obj["allowed_domains"]) ||
      !obj["allowed_domains"].every((d) => typeof d === "string")
    ) {
      throw new Error("web_search: 'allowed_domains' must be a string array");
    }
    args.allowed_domains = obj["allowed_domains"] as string[];
  }
  if (obj["blocked_domains"] !== undefined) {
    if (
      !Array.isArray(obj["blocked_domains"]) ||
      !obj["blocked_domains"].every((d) => typeof d === "string")
    ) {
      throw new Error("web_search: 'blocked_domains' must be a string array");
    }
    args.blocked_domains = obj["blocked_domains"] as string[];
  }
  return args;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\./, "");
  if (!p) return false;
  return host === p || host.endsWith(`.${p}`);
}

export function applyFilters(
  results: WebSearchResult[],
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): WebSearchResult[] {
  return results.filter((r) => {
    const h = hostnameOf(r.url);
    if (!h) return false;
    if (allowed && allowed.length > 0) {
      if (!allowed.some((d) => domainMatches(h, d))) return false;
    }
    if (blocked && blocked.length > 0) {
      if (blocked.some((d) => domainMatches(h, d))) return false;
    }
    return true;
  });
}

async function readJsonConfig(): Promise<ProviderConfig | null> {
  const file = path.join(os.homedir(), ".enclo", "web-search.json");
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const provider = obj["provider"];
  const apiKey = obj["api_key"];
  if (typeof provider !== "string" || typeof apiKey !== "string") return null;
  if (!["brave", "serper", "tavily", "google"].includes(provider)) return null;
  const cfg: ProviderConfig = {
    provider: provider as ProviderConfig["provider"],
    apiKey,
  };
  if (typeof obj["cx"] === "string") cfg.cx = obj["cx"];
  return cfg;
}

function readEnvConfig(env: NodeJS.ProcessEnv): ProviderConfig | null {
  const apiKey = env["WEB_SEARCH_API_KEY"];
  const provider = env["WEB_SEARCH_PROVIDER"];
  if (!apiKey || !provider) return null;
  if (!["brave", "serper", "tavily", "google"].includes(provider)) return null;
  const cfg: ProviderConfig = {
    provider: provider as ProviderConfig["provider"],
    apiKey,
  };
  const cx = env["WEB_SEARCH_CX"];
  if (cx) cfg.cx = cx;
  return cfg;
}

interface SearchDeps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  loadFileConfig: () => Promise<ProviderConfig | null>;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(
        `web_search: provider returned HTTP ${resp.status} ${resp.statusText}`,
      );
    }
    return await resp.json();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`web_search: provider request timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(
        `web_search: DuckDuckGo returned HTTP ${resp.status} ${resp.statusText}`,
      );
    }
    return await resp.text();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`web_search: DuckDuckGo request timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function searchBrave(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  count: number,
): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const data = (await fetchJson(fetchImpl, url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  })) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  const results = data.web?.results ?? [];
  return results.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

async function searchSerper(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  count: number,
): Promise<WebSearchResult[]> {
  const data = (await fetchJson(fetchImpl, "https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: count }),
  })) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  const results = data.organic ?? [];
  return results.map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

async function searchTavily(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  count: number,
): Promise<WebSearchResult[]> {
  const data = (await fetchJson(fetchImpl, "https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count }),
  })) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const results = data.results ?? [];
  return results.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function searchGoogle(
  fetchImpl: typeof fetch,
  apiKey: string,
  cx: string | undefined,
  query: string,
  count: number,
): Promise<WebSearchResult[]> {
  if (!cx) {
    throw new Error(
      "web_search: Google Custom Search requires WEB_SEARCH_CX (or `cx` in ~/.enclo/web-search.json)",
    );
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`;
  const data = (await fetchJson(fetchImpl, url, {
    method: "GET",
    headers: { Accept: "application/json" },
  })) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
  const results = data.items ?? [];
  return results.map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
}

/**
 * DDG redirect URLs look like `/l/?uddg=<encoded-real-url>` (or
 * `//duckduckgo.com/l/?uddg=...`). Unwrap to the real destination.
 */
function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    if (u.pathname === "/l/" || u.pathname.endsWith("/l/")) {
      const real = u.searchParams.get("uddg");
      if (real) return decodeURIComponent(real);
    }
    return u.toString();
  } catch {
    return href;
  }
}

/**
 * Best-effort scrape of html.duckduckgo.com — the no-JS rendering. Looks for
 * `.result__title a` for title+URL and `.result__snippet` for snippet body.
 * If DDG changes its HTML, this returns an empty list rather than throwing.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Each hit is roughly: <h2 class="result__title"><a class="result__a" href="...">TITLE</a></h2>
  // ... <a class="result__snippet" ...>SNIPPET</a>
  // We pair them up positionally.
  const titleRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const titles: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    const href = m[1];
    const titleHtml = m[2];
    if (!href || !titleHtml) continue;
    titles.push({
      url: unwrapDuckDuckGoUrl(href),
      title: stripTags(titleHtml),
    });
  }
  while ((m = snippetRe.exec(html)) !== null) {
    const body = m[1];
    if (!body) continue;
    snippets.push(stripTags(body));
  }
  for (let i = 0; i < titles.length; i += 1) {
    const t = titles[i];
    if (!t) continue;
    results.push({
      title: t.title,
      url: t.url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}

async function searchDuckDuckGo(
  fetchImpl: typeof fetch,
  query: string,
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(fetchImpl, url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; enclo-code/0.1; +https://enclo.example)",
      Accept: "text/html",
    },
  });
  return parseDuckDuckGoHtml(html);
}

async function pickProvider(
  deps: SearchDeps,
): Promise<ProviderConfig | null> {
  const env = readEnvConfig(deps.env);
  if (env) return env;
  return await deps.loadFileConfig();
}

export async function executeWebSearch(
  raw: unknown,
  _ctx: ToolContext,
  deps: Partial<SearchDeps> = {},
): Promise<ToolResult> {
  const args = parseArgs(raw);
  const fetchImpl = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const loadFileConfig = deps.loadFileConfig ?? readJsonConfig;
  const max = args.max_results ?? DEFAULT_MAX_RESULTS;

  let provider: WebSearchProvider;
  let raw_results: WebSearchResult[];
  try {
    const cfg = await pickProvider({ fetch: fetchImpl, env, loadFileConfig });
    if (cfg) {
      provider = cfg.provider;
      switch (cfg.provider) {
        case "brave":
          raw_results = await searchBrave(fetchImpl, cfg.apiKey, args.query, max);
          break;
        case "serper":
          raw_results = await searchSerper(fetchImpl, cfg.apiKey, args.query, max);
          break;
        case "tavily":
          raw_results = await searchTavily(fetchImpl, cfg.apiKey, args.query, max);
          break;
        case "google":
          raw_results = await searchGoogle(
            fetchImpl,
            cfg.apiKey,
            cfg.cx,
            args.query,
            max,
          );
          break;
      }
    } else {
      provider = "duckduckgo";
      raw_results = await searchDuckDuckGo(fetchImpl, args.query);
    }
  } catch (err) {
    return { isError: true, content: (err as Error).message };
  }

  const filtered = applyFilters(
    raw_results,
    args.allowed_domains,
    args.blocked_domains,
  ).slice(0, max);

  const payload: WebSearchResponse = { results: filtered, provider };
  const lines = filtered
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
  const header = `provider: ${provider} — ${filtered.length} result${filtered.length === 1 ? "" : "s"}`;
  return {
    content: filtered.length > 0
      ? `${header}\n\n${lines}\n\n${JSON.stringify(payload)}`
      : `${header}\n\n(no results)\n\n${JSON.stringify(payload)}`,
    display: {
      kind: "list",
      items: filtered.map((r) => `${r.title} — ${r.url}`),
    },
  };
}

export const webSearch: Tool = {
  category: "exec",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for a query and return ranked results (title, url, snippet). Provider is chosen in priority order: (1) WEB_SEARCH_PROVIDER + WEB_SEARCH_API_KEY env vars, (2) ~/.enclo/web-search.json, (3) DuckDuckGo HTML scrape (best-effort fallback). Optional allowed_domains/blocked_domains filter results by host.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query.",
          },
          max_results: {
            type: "integer",
            description: `Max results to return. Default ${DEFAULT_MAX_RESULTS}, hard cap ${HARD_MAX_RESULTS}.`,
          },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description:
              "If set, only include results whose hostname matches one of these domains (subdomain match).",
          },
          blocked_domains: {
            type: "array",
            items: { type: "string" },
            description:
              "Exclude results whose hostname matches one of these domains (subdomain match).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    return executeWebSearch(raw, ctx);
  },
};
