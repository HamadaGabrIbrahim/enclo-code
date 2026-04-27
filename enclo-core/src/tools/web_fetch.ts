import dns from "node:dns";
import { promisify } from "node:util";
import net from "node:net";
import TurndownService from "turndown";
import type { Tool, ToolResult, ToolContext } from "./types.js";

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 15 * 60 * 1000;

const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/xhtml+xml",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.azure.com",
]);

interface CacheEntry {
  markdown: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

interface FetchedContent {
  url: string;
  markdown: string;
}

interface DnsLookupResult {
  address: string;
  family: number;
}

export interface WebFetchDeps {
  fetch?: typeof fetch;
  dnsLookup?: (hostname: string) => Promise<DnsLookupResult>;
  turndown?: (html: string) => string;
  now?: () => number;
}

const defaultDnsLookup = promisify(dns.lookup) as unknown as (
  hostname: string,
) => Promise<DnsLookupResult>;

let defaultTurndownService: TurndownService | null = null;
function defaultTurndown(html: string): string {
  if (!defaultTurndownService) {
    defaultTurndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
  }
  return defaultTurndownService.turndown(html);
}

interface Args {
  url: string;
  prompt: string;
}

function parseArgs(raw: unknown): Args {
  if (!raw || typeof raw !== "object") {
    throw new Error("web_fetch: expected object arguments");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["url"] !== "string" || obj["url"].length === 0) {
    throw new Error("web_fetch: 'url' must be a non-empty string");
  }
  if (typeof obj["prompt"] !== "string" || obj["prompt"].length === 0) {
    throw new Error("web_fetch: 'prompt' must be a non-empty string");
  }
  return { url: obj["url"], prompt: obj["prompt"] };
}

/**
 * Returns true if the IP address falls in a private, loopback, link-local,
 * or cloud-metadata range that we never want to allow outbound HTTP to.
 */
export function isBlockedIp(ip: string): boolean {
  if (ip === "169.254.169.254") return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a === 169 && b === 254) return true; // 169.254/16 link-local
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    return false;
  }
  return true; // not a valid IP, refuse
}

function isBlockedHostname(host: string): boolean {
  return BLOCKED_HOSTNAMES.has(host.toLowerCase());
}

async function validateUrl(
  rawUrl: string,
  dnsLookup: (h: string) => Promise<DnsLookupResult>,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`web_fetch: invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `web_fetch: only http/https URLs are allowed (got ${parsed.protocol})`,
    );
  }
  const host = parsed.hostname;
  if (isBlockedHostname(host)) {
    throw new Error(`web_fetch: hostname '${host}' is blocked`);
  }
  // If the host is itself a literal IP, validate it directly.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error(
        `web_fetch: address '${host}' is in a blocked range (SSRF protection)`,
      );
    }
    return parsed;
  }
  let resolved: DnsLookupResult;
  try {
    resolved = await dnsLookup(host);
  } catch (err) {
    throw new Error(
      `web_fetch: DNS lookup failed for ${host}: ${(err as Error).message}`,
    );
  }
  if (isBlockedIp(resolved.address)) {
    throw new Error(
      `web_fetch: ${host} resolves to blocked address ${resolved.address} (SSRF protection)`,
    );
  }
  return parsed;
}

function isAllowedContentType(ct: string | null): boolean {
  if (!ct) return false;
  const base = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_CONTENT_TYPES.includes(base);
}

async function readBodyWithLimit(
  resp: Response,
  maxBytes: number,
): Promise<string> {
  const cl = resp.headers.get("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(
        `web_fetch: response body too large (${n} bytes, max ${maxBytes})`,
      );
    }
  }
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(
          `web_fetch: response body exceeded ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.toString("utf8");
}

/**
 * Fetch an HTTP(S) URL with manual redirect handling so each hop's
 * resolved IP is SSRF-checked. Returns the final URL and the body
 * converted to markdown.
 */
async function fetchToMarkdown(
  rawUrl: string,
  deps: Required<Pick<WebFetchDeps, "fetch" | "dnsLookup" | "turndown">>,
): Promise<FetchedContent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let currentUrl = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const validated = await validateUrl(currentUrl, deps.dnsLookup);
      const resp = await deps.fetch(validated.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "enclo-code/0.1",
          Accept:
            "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        if (!loc) {
          throw new Error(
            `web_fetch: ${resp.status} redirect without Location header`,
          );
        }
        if (hop >= MAX_REDIRECTS) {
          throw new Error(
            `web_fetch: exceeded max redirects (${MAX_REDIRECTS})`,
          );
        }
        currentUrl = new URL(loc, validated).toString();
        continue;
      }
      if (!resp.ok) {
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(`web_fetch: HTTP ${resp.status} ${resp.statusText}`);
      }
      const ct = resp.headers.get("content-type");
      if (!isAllowedContentType(ct)) {
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(
          `web_fetch: unsupported content-type '${ct ?? "(none)"}' (only HTML/plaintext)`,
        );
      }
      const body = await readBodyWithLimit(resp, MAX_BODY_BYTES);
      const isHtml =
        (ct ?? "").toLowerCase().includes("html") ||
        (ct ?? "").toLowerCase().includes("xhtml");
      const markdown = isHtml ? deps.turndown(body) : body;
      return { url: validated.toString(), markdown };
    }
    throw new Error(`web_fetch: exceeded max redirects (${MAX_REDIRECTS})`);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`web_fetch: request timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Internal entry point exposed for tests — lets callers swap fetch/dns/turndown
 * and override the model summarization step.
 */
export async function executeWebFetch(
  raw: unknown,
  ctx: ToolContext,
  deps: WebFetchDeps = {},
): Promise<ToolResult> {
  const args = parseArgs(raw);
  const fetchImpl = deps.fetch ?? fetch;
  const dnsLookup = deps.dnsLookup ?? defaultDnsLookup;
  const turndown = deps.turndown ?? defaultTurndown;
  const now = deps.now ?? Date.now;

  // Pre-validate the URL once so we can short-circuit before fetching the
  // cache (avoid leaking SSRF resolution for cached entries created from a
  // previous, now-stale lookup).
  try {
    await validateUrl(args.url, dnsLookup);
  } catch (err) {
    return { isError: true, content: (err as Error).message };
  }

  let fetched: FetchedContent;
  // Cache key uses the original requested URL; we cache the markdown of
  // the final (post-redirect) page. Redirect chains that change resolve
  // again because TTL invalidates after 15 minutes.
  const cacheKey = args.url;
  const hit = cache.get(cacheKey);
  let cacheUsed = false;
  if (hit && now() - hit.fetchedAt < CACHE_TTL_MS) {
    fetched = { url: cacheKey, markdown: hit.markdown };
    cacheUsed = true;
  } else {
    try {
      fetched = await fetchToMarkdown(args.url, {
        fetch: fetchImpl,
        dnsLookup,
        turndown,
      });
    } catch (err) {
      return { isError: true, content: (err as Error).message };
    }
    cache.set(fetched.url, { markdown: fetched.markdown, fetchedAt: now() });
    if (fetched.url !== cacheKey) {
      cache.set(cacheKey, { markdown: fetched.markdown, fetchedAt: now() });
    }
  }

  if (!ctx.agent?.oneshot) {
    // No model available — return the raw markdown as a fallback.
    return {
      content: fetched.markdown,
      display: {
        kind: "text",
        preview: fetched.markdown.slice(0, 200),
      },
    };
  }

  let answer: string;
  try {
    answer = await ctx.agent.oneshot({
      system:
        "You are summarizing web content. Answer the user's question about the content concisely.",
      user: `Question: ${args.prompt}\n\nContent:\n${fetched.markdown}`,
      maxTokens: 1024,
    });
  } catch (err) {
    return {
      isError: true,
      content: `web_fetch: model summarization failed: ${(err as Error).message}`,
    };
  }
  const trimmed = answer.trim();
  const note = cacheUsed ? " (cached)" : "";
  return {
    content: `${trimmed}\n\n[source: ${fetched.url}${note}]`,
    display: { kind: "text", preview: trimmed.slice(0, 200) },
  };
}

/** Test-only: clear the in-memory fetch cache. */
export function _clearWebFetchCache(): void {
  cache.clear();
}

export const webFetch: Tool = {
  category: "exec",
  requiresPermission: true,
  definition: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a public web page (http/https), convert its HTML to markdown, then ask the active model to answer 'prompt' about that content. Returns the model's concise answer. Limits: 30s timeout, 10MB body, max 5 redirects, only HTML/plaintext content. Private/loopback/cloud-metadata addresses are blocked. Results are cached in-memory for 15 minutes per URL.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full http(s) URL to fetch.",
          },
          prompt: {
            type: "string",
            description: "Question or instruction to apply to the fetched page.",
          },
        },
        required: ["url", "prompt"],
        additionalProperties: false,
      },
    },
  },
  async execute(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
    return executeWebFetch(raw, ctx);
  },
};
