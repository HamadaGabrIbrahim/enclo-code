import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  webFetch,
  executeWebFetch,
  isBlockedIp,
  _clearWebFetchCache,
  type WebFetchDeps,
} from "../../src/tools/web_fetch.js";
import type { ToolContext } from "../../src/tools/types.js";

interface MockResponseInit {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

function makeResponse(init: MockResponseInit): Response {
  const headers = new Headers(init.headers ?? {});
  const status = init.status ?? 200;
  const body =
    init.body === undefined
      ? null
      : typeof init.body === "string"
        ? new TextEncoder().encode(init.body)
        : init.body;
  return new Response(body, { status, headers });
}

interface MockSpec {
  url: string;
  response: MockResponseInit;
}

function mockFetch(specs: MockSpec[]): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const spec = specs[i++];
    if (!spec) throw new Error(`unexpected fetch ${String(input)}`);
    if (spec.url !== String(input)) {
      throw new Error(`fetch URL mismatch: expected ${spec.url}, got ${input}`);
    }
    return makeResponse(spec.response);
  }) as unknown as typeof fetch;
}

function dnsAlways(address: string, family = 4) {
  return async (): Promise<{ address: string; family: number }> => ({
    address,
    family,
  });
}

function ctxWithOneshot(
  oneshot?: (a: { system: string; user: string }) => Promise<string>,
): ToolContext {
  if (!oneshot) return { cwd: "/tmp" };
  return {
    cwd: "/tmp",
    agent: {
      depth: 0,
      spawn: async () => ({ text: "", isError: false }),
      oneshot: async (a) => oneshot(a),
    },
  };
}

beforeEach(() => {
  _clearWebFetchCache();
});

describe("web_fetch", () => {
  it("declares itself as exec category, requires permission", () => {
    expect(webFetch.category).toBe("exec");
    expect(webFetch.requiresPermission).toBe(true);
    expect(webFetch.definition.function.name).toBe("web_fetch");
  });

  describe("isBlockedIp", () => {
    it("blocks IPv4 loopback", () => {
      expect(isBlockedIp("127.0.0.1")).toBe(true);
      expect(isBlockedIp("127.255.255.254")).toBe(true);
    });
    it("blocks RFC1918 ranges", () => {
      expect(isBlockedIp("10.0.0.1")).toBe(true);
      expect(isBlockedIp("172.16.0.5")).toBe(true);
      expect(isBlockedIp("172.31.255.255")).toBe(true);
      expect(isBlockedIp("192.168.1.1")).toBe(true);
    });
    it("blocks link-local + cloud metadata", () => {
      expect(isBlockedIp("169.254.0.1")).toBe(true);
      expect(isBlockedIp("169.254.169.254")).toBe(true);
    });
    it("blocks 0.0.0.0/8", () => {
      expect(isBlockedIp("0.0.0.0")).toBe(true);
    });
    it("blocks IPv6 loopback + ULA + link-local", () => {
      expect(isBlockedIp("::1")).toBe(true);
      expect(isBlockedIp("fe80::1")).toBe(true);
      expect(isBlockedIp("fc00::1")).toBe(true);
      expect(isBlockedIp("fd12:3456:7890::1")).toBe(true);
    });
    it("allows ordinary public IPv4", () => {
      expect(isBlockedIp("8.8.8.8")).toBe(false);
      expect(isBlockedIp("1.1.1.1")).toBe(false);
      expect(isBlockedIp("172.15.0.1")).toBe(false);
      expect(isBlockedIp("172.32.0.1")).toBe(false);
    });
  });

  it("rejects non-http URLs", async () => {
    const r = await executeWebFetch(
      { url: "ftp://example.com/x", prompt: "x" },
      ctxWithOneshot(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/only http\/https/);
  });

  it("rejects file:// URLs", async () => {
    const r = await executeWebFetch(
      { url: "file:///etc/passwd", prompt: "x" },
      ctxWithOneshot(),
    );
    expect(r.isError).toBe(true);
  });

  it("rejects literal localhost hostname", async () => {
    const r = await executeWebFetch(
      { url: "http://localhost/x", prompt: "x" },
      ctxWithOneshot(),
      { dnsLookup: dnsAlways("8.8.8.8") },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/blocked/);
  });

  it("rejects metadata.google.internal", async () => {
    const r = await executeWebFetch(
      { url: "http://metadata.google.internal/x", prompt: "x" },
      ctxWithOneshot(),
      { dnsLookup: dnsAlways("169.254.169.254") },
    );
    expect(r.isError).toBe(true);
  });

  it("rejects when DNS resolves to a blocked range (SSRF)", async () => {
    const r = await executeWebFetch(
      { url: "http://internal.evil.example/x", prompt: "x" },
      ctxWithOneshot(),
      { dnsLookup: dnsAlways("192.168.1.5") },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF/);
  });

  it("rejects literal private IP in URL", async () => {
    const r = await executeWebFetch(
      { url: "http://127.0.0.1/x", prompt: "x" },
      ctxWithOneshot(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF/);
  });

  it("rejects literal cloud-metadata IP", async () => {
    const r = await executeWebFetch(
      { url: "http://169.254.169.254/latest/meta-data", prompt: "x" },
      ctxWithOneshot(),
    );
    expect(r.isError).toBe(true);
  });

  it("happy path: fetches HTML, converts via turndown, calls oneshot", async () => {
    const fetchImpl = mockFetch([
      {
        url: "https://example.com/page",
        response: {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><body><h1>Hello</h1><p>World.</p></body></html>",
        },
      },
    ]);
    const oneshot = vi.fn(
      async ({ system, user }: { system: string; user: string }) => {
        expect(system).toMatch(/summarizing web content/);
        expect(user).toMatch(/Question: greet me/);
        expect(user).toMatch(/Hello/);
        expect(user).toMatch(/World\./);
        return "Greetings from example.com.";
      },
    );
    const r = await executeWebFetch(
      { url: "https://example.com/page", prompt: "greet me" },
      ctxWithOneshot(oneshot),
      { fetch: fetchImpl, dnsLookup: dnsAlways("93.184.216.34") },
    );
    expect(r.isError).not.toBe(true);
    expect(oneshot).toHaveBeenCalledOnce();
    expect(r.content).toContain("Greetings from example.com.");
    expect(r.content).toContain("[source: https://example.com/page]");
  });

  it("converts turndown output is used (markdown headings)", async () => {
    const fetchImpl = mockFetch([
      {
        url: "https://example.com/p",
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<h2>Title</h2><p>Body text</p>",
        },
      },
    ]);
    let captured = "";
    const oneshot = async ({ user }: { user: string }) => {
      captured = user;
      return "ok";
    };
    await executeWebFetch(
      { url: "https://example.com/p", prompt: "what?" },
      ctxWithOneshot(oneshot),
      { fetch: fetchImpl, dnsLookup: dnsAlways("8.8.8.8") },
    );
    // turndown atx headings → ## Title
    expect(captured).toMatch(/## Title/);
    expect(captured).toMatch(/Body text/);
  });

  it("rejects binary content-type", async () => {
    const fetchImpl = mockFetch([
      {
        url: "https://example.com/img",
        response: {
          status: 200,
          headers: { "content-type": "image/png" },
          body: "binary",
        },
      },
    ]);
    const r = await executeWebFetch(
      { url: "https://example.com/img", prompt: "x" },
      ctxWithOneshot(async () => "x"),
      { fetch: fetchImpl, dnsLookup: dnsAlways("8.8.8.8") },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/unsupported content-type/);
  });

  it("rejects body larger than 10MB via Content-Length", async () => {
    const fetchImpl = mockFetch([
      {
        url: "https://example.com/big",
        response: {
          status: 200,
          headers: {
            "content-type": "text/html",
            "content-length": String(11 * 1024 * 1024),
          },
          body: "<p>x</p>",
        },
      },
    ]);
    const r = await executeWebFetch(
      { url: "https://example.com/big", prompt: "x" },
      ctxWithOneshot(async () => "x"),
      { fetch: fetchImpl, dnsLookup: dnsAlways("8.8.8.8") },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/too large/);
  });

  it("rejects body that streams past 10MB without Content-Length", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 100).fill(65); // 'A' bytes
    const fetchImpl = mockFetch([
      {
        url: "https://example.com/big2",
        response: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: big,
        },
      },
    ]);
    const r = await executeWebFetch(
      { url: "https://example.com/big2", prompt: "x" },
      ctxWithOneshot(async () => "x"),
      { fetch: fetchImpl, dnsLookup: dnsAlways("8.8.8.8") },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exceeded.*bytes/);
  });

  it("rejects when redirect chain exceeds max", async () => {
    const specs: MockSpec[] = [];
    for (let i = 0; i < 6; i += 1) {
      specs.push({
        url: `https://example.com/r${i}`,
        response: {
          status: 302,
          headers: { location: `https://example.com/r${i + 1}` },
        },
      });
    }
    const fetchImpl = mockFetch(specs);
    const r = await executeWebFetch(
      { url: "https://example.com/r0", prompt: "x" },
      ctxWithOneshot(async () => "x"),
      { fetch: fetchImpl, dnsLookup: dnsAlways("8.8.8.8") },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/max redirects/);
  });

  it("follows up to 5 redirects then succeeds", async () => {
    const specs: MockSpec[] = [];
    for (let i = 0; i < 4; i += 1) {
      specs.push({
        url: `https://example.com/r${i}`,
        response: {
          status: 302,
          headers: { location: `https://example.com/r${i + 1}` },
        },
      });
    }
    specs.push({
      url: "https://example.com/r4",
      response: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<p>final</p>",
      },
    });
    const fetchImpl = mockFetch(specs);
    const r = await executeWebFetch(
      { url: "https://example.com/r0", prompt: "x" },
      ctxWithOneshot(async () => "ok"),
      { fetch: fetchImpl, dnsLookup: dnsAlways("8.8.8.8") },
    );
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("ok");
  });

  it("revalidates SSRF on each redirect hop", async () => {
    const fetchImpl = mockFetch([
      {
        url: "https://example.com/start",
        response: {
          status: 302,
          headers: { location: "http://internal.example/secret" },
        },
      },
    ]);
    let calls = 0;
    const dnsLookup = async (host: string) => {
      calls += 1;
      if (host === "example.com") return { address: "8.8.8.8", family: 4 };
      if (host === "internal.example")
        return { address: "192.168.0.1", family: 4 };
      return { address: "8.8.8.8", family: 4 };
    };
    const r = await executeWebFetch(
      { url: "https://example.com/start", prompt: "x" },
      ctxWithOneshot(async () => "x"),
      { fetch: fetchImpl, dnsLookup },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF/);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("returns timeout error when fetch aborts", async () => {
    const slowFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          sig.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const promise = executeWebFetch(
        { url: "https://example.com/slow", prompt: "x" },
        ctxWithOneshot(async () => "x"),
        { fetch: slowFetch, dnsLookup: dnsAlways("8.8.8.8") },
      );
      await vi.advanceTimersByTimeAsync(31_000);
      const r = await promise;
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches second fetch within the 15-minute TTL", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      fetchCalls += 1;
      expect(String(input)).toBe("https://example.com/cached");
      return makeResponse({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<p>cached body</p>",
      });
    }) as unknown as typeof fetch;
    let nowMs = 1_000_000;
    const deps: WebFetchDeps = {
      fetch: fetchImpl,
      dnsLookup: dnsAlways("8.8.8.8"),
      now: () => nowMs,
    };
    const oneshot = vi.fn(async () => "summary");
    await executeWebFetch(
      { url: "https://example.com/cached", prompt: "x" },
      ctxWithOneshot(oneshot),
      deps,
    );
    nowMs += 5 * 60 * 1000; // 5 min later
    const r2 = await executeWebFetch(
      { url: "https://example.com/cached", prompt: "y" },
      ctxWithOneshot(oneshot),
      deps,
    );
    expect(fetchCalls).toBe(1);
    expect(r2.content).toMatch(/\(cached\)/);
    expect(oneshot).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the 15-minute TTL expires", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCalls += 1;
      return makeResponse({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<p>x</p>",
      });
    }) as unknown as typeof fetch;
    let nowMs = 1_000_000;
    const deps: WebFetchDeps = {
      fetch: fetchImpl,
      dnsLookup: dnsAlways("8.8.8.8"),
      now: () => nowMs,
    };
    await executeWebFetch(
      { url: "https://example.com/exp", prompt: "x" },
      ctxWithOneshot(async () => "ok"),
      deps,
    );
    nowMs += 16 * 60 * 1000;
    await executeWebFetch(
      { url: "https://example.com/exp", prompt: "x" },
      ctxWithOneshot(async () => "ok"),
      deps,
    );
    expect(fetchCalls).toBe(2);
  });

  it("rejects malformed args", async () => {
    await expect(
      executeWebFetch({}, ctxWithOneshot()),
    ).rejects.toThrow();
    await expect(
      executeWebFetch({ url: "https://x" }, ctxWithOneshot()),
    ).rejects.toThrow();
    await expect(
      executeWebFetch({ url: "", prompt: "y" }, ctxWithOneshot()),
    ).rejects.toThrow();
  });
});
