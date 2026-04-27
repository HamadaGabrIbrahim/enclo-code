import { describe, expect, it } from "vitest";
import {
  webSearch,
  executeWebSearch,
  applyFilters,
  parseDuckDuckGoHtml,
  type WebSearchResponse,
} from "../../src/tools/web_search.js";
import type { ToolContext } from "../../src/tools/types.js";

const ctx: ToolContext = { cwd: "/tmp" };

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: FetchCall = { url: String(input) };
    if (init) call.init = init;
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function parsePayload(content: string): WebSearchResponse {
  const lines = content.split("\n");
  const last = lines[lines.length - 1];
  if (!last) throw new Error("no JSON payload in content");
  return JSON.parse(last) as WebSearchResponse;
}

describe("web_search", () => {
  it("declares itself as exec category, requires permission", () => {
    expect(webSearch.category).toBe("exec");
    expect(webSearch.requiresPermission).toBe(true);
    expect(webSearch.definition.function.name).toBe("web_search");
  });

  it("rejects empty query", async () => {
    await expect(executeWebSearch({}, ctx)).rejects.toThrow();
    await expect(executeWebSearch({ query: "" }, ctx)).rejects.toThrow();
    await expect(executeWebSearch({ query: "   " }, ctx)).rejects.toThrow();
  });

  it("uses Brave when configured via env", async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({
        web: {
          results: [
            {
              title: "TS docs",
              url: "https://typescriptlang.org",
              description: "Official",
            },
            {
              title: "Foo",
              url: "https://foo.example/x",
              description: "About foo",
            },
          ],
        },
      }),
    );
    const r = await executeWebSearch({ query: "typescript" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "brave-key",
        WEB_SEARCH_PROVIDER: "brave",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toContain("api.search.brave.com");
    expect(call.url).toContain("q=typescript");
    expect((call.init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe(
      "brave-key",
    );
    const payload = parsePayload(r.content);
    expect(payload.provider).toBe("brave");
    expect(payload.results).toHaveLength(2);
    const first = payload.results[0];
    if (!first) throw new Error("no result");
    expect(first.title).toBe("TS docs");
    expect(first.url).toBe("https://typescriptlang.org");
    expect(first.snippet).toBe("Official");
  });

  it("uses Serper when configured", async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({
        organic: [
          { title: "A", link: "https://a.example", snippet: "alpha" },
          { title: "B", link: "https://b.example", snippet: "beta" },
        ],
      }),
    );
    const r = await executeWebSearch({ query: "abc" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "serper-key",
        WEB_SEARCH_PROVIDER: "serper",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).not.toBe(true);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toBe("https://google.serper.dev/search");
    expect((call.init?.headers as Record<string, string>)["X-API-KEY"]).toBe(
      "serper-key",
    );
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(call.init?.body as string);
    expect(body.q).toBe("abc");
    const payload = parsePayload(r.content);
    expect(payload.provider).toBe("serper");
    expect(payload.results).toHaveLength(2);
  });

  it("uses Tavily when configured", async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({
        results: [
          { title: "T1", url: "https://t1.example", content: "snippet1" },
        ],
      }),
    );
    const r = await executeWebSearch({ query: "topic", max_results: 3 }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "tav-key",
        WEB_SEARCH_PROVIDER: "tavily",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).not.toBe(true);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toBe("https://api.tavily.com/search");
    const body = JSON.parse(call.init?.body as string);
    expect(body.api_key).toBe("tav-key");
    expect(body.max_results).toBe(3);
    const payload = parsePayload(r.content);
    expect(payload.provider).toBe("tavily");
    expect(payload.results[0]?.snippet).toBe("snippet1");
  });

  it("uses Google Custom Search when configured (with cx)", async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({
        items: [
          { title: "G1", link: "https://g1.example", snippet: "snippet" },
        ],
      }),
    );
    const r = await executeWebSearch({ query: "anything" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "g-key",
        WEB_SEARCH_PROVIDER: "google",
        WEB_SEARCH_CX: "engine-id",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).not.toBe(true);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toContain("googleapis.com/customsearch/v1");
    expect(call.url).toContain("key=g-key");
    expect(call.url).toContain("cx=engine-id");
    const payload = parsePayload(r.content);
    expect(payload.provider).toBe("google");
  });

  it("errors when Google is selected without cx", async () => {
    const { fn } = mockFetch(() => jsonResponse({}));
    const r = await executeWebSearch({ query: "x" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "g-key",
        WEB_SEARCH_PROVIDER: "google",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/WEB_SEARCH_CX/);
  });

  it("falls back to ~/.enclo/web-search.json when env is unset", async () => {
    const { fn, calls } = mockFetch(() =>
      jsonResponse({
        organic: [{ title: "X", link: "https://x.example", snippet: "x" }],
      }),
    );
    const r = await executeWebSearch({ query: "z" }, ctx, {
      fetch: fn,
      env: {} as NodeJS.ProcessEnv,
      loadFileConfig: async () => ({
        provider: "serper",
        apiKey: "from-file",
      }),
    });
    expect(r.isError).not.toBe(true);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect((call.init?.headers as Record<string, string>)["X-API-KEY"]).toBe(
      "from-file",
    );
    const payload = parsePayload(r.content);
    expect(payload.provider).toBe("serper");
  });

  it("falls back to DuckDuckGo when no env and no file config", async () => {
    const html = `
      <div>
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Example One</a>
        </h2>
        <a class="result__snippet" href="https://example.com/one">snippet one body</a>
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Ftwo">Example Two</a>
        </h2>
        <a class="result__snippet" href="https://example.org/two">snippet two body</a>
      </div>
    `;
    const { fn, calls } = mockFetch(() => textResponse(html));
    const r = await executeWebSearch({ query: "anything" }, ctx, {
      fetch: fn,
      env: {} as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).not.toBe(true);
    const call = calls[0];
    if (!call) throw new Error("no call");
    expect(call.url).toContain("html.duckduckgo.com/html");
    const payload = parsePayload(r.content);
    expect(payload.provider).toBe("duckduckgo");
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]?.url).toBe("https://example.com/one");
    expect(payload.results[0]?.title).toBe("Example One");
    expect(payload.results[0]?.snippet).toBe("snippet one body");
    expect(payload.results[1]?.url).toBe("https://example.org/two");
  });

  it("parseDuckDuckGoHtml on empty/garbled input returns []", () => {
    expect(parseDuckDuckGoHtml("")).toEqual([]);
    expect(parseDuckDuckGoHtml("<html><body>no results here</body></html>")).toEqual(
      [],
    );
  });

  it("applies allowed_domains filter (subdomain match)", () => {
    const filtered = applyFilters(
      [
        { title: "a", url: "https://docs.python.org/3/", snippet: "" },
        { title: "b", url: "https://stackoverflow.com/q/123", snippet: "" },
        { title: "c", url: "https://python.org/about/", snippet: "" },
      ],
      ["python.org"],
      undefined,
    );
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.url)).toEqual([
      "https://docs.python.org/3/",
      "https://python.org/about/",
    ]);
  });

  it("applies blocked_domains filter (subdomain match)", () => {
    const filtered = applyFilters(
      [
        { title: "a", url: "https://reddit.com/r/x", snippet: "" },
        { title: "b", url: "https://old.reddit.com/r/y", snippet: "" },
        { title: "c", url: "https://example.com", snippet: "" },
      ],
      undefined,
      ["reddit.com"],
    );
    expect(filtered.map((r) => r.url)).toEqual(["https://example.com"]);
  });

  it("end-to-end filters allowed_domains via tool", async () => {
    const { fn } = mockFetch(() =>
      jsonResponse({
        web: {
          results: [
            { title: "ok", url: "https://docs.example.com/x", description: "" },
            { title: "no", url: "https://other.example/y", description: "" },
          ],
        },
      }),
    );
    const r = await executeWebSearch(
      { query: "q", allowed_domains: ["example.com"] },
      ctx,
      {
        fetch: fn,
        env: {
          WEB_SEARCH_API_KEY: "k",
          WEB_SEARCH_PROVIDER: "brave",
        } as NodeJS.ProcessEnv,
        loadFileConfig: async () => null,
      },
    );
    const payload = parsePayload(r.content);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.url).toBe("https://docs.example.com/x");
  });

  it("enforces max_results (default 10, hard cap 20)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `t${i}`,
      url: `https://e${i}.example`,
      description: "",
    }));
    const { fn } = mockFetch(() => jsonResponse({ web: { results: many } }));
    const r = await executeWebSearch({ query: "q" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "k",
        WEB_SEARCH_PROVIDER: "brave",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    const payload = parsePayload(r.content);
    expect(payload.results).toHaveLength(10);

    const r2 = await executeWebSearch({ query: "q", max_results: 50 }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "k",
        WEB_SEARCH_PROVIDER: "brave",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    const payload2 = parsePayload(r2.content);
    // hard-capped to 20
    expect(payload2.results.length).toBeLessThanOrEqual(20);
  });

  it("propagates HTTP errors from provider as tool error", async () => {
    const { fn } = mockFetch(() => new Response("nope", { status: 401 }));
    const r = await executeWebSearch({ query: "q" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "k",
        WEB_SEARCH_PROVIDER: "brave",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/HTTP 401/);
  });

  it("rejects unknown WEB_SEARCH_PROVIDER (falls back to DDG)", async () => {
    let usedDDG = false;
    const { fn } = mockFetch((c) => {
      if (c.url.includes("duckduckgo.com")) {
        usedDDG = true;
        return textResponse("");
      }
      throw new Error("should not call non-DDG");
    });
    const r = await executeWebSearch({ query: "q" }, ctx, {
      fetch: fn,
      env: {
        WEB_SEARCH_API_KEY: "k",
        WEB_SEARCH_PROVIDER: "made-up",
      } as NodeJS.ProcessEnv,
      loadFileConfig: async () => null,
    });
    expect(r.isError).not.toBe(true);
    expect(usedDDG).toBe(true);
  });
});
