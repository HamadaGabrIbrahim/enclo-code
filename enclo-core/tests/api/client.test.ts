import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ApiClient, AuthError } from "../../src/api/client.js";
import { createMemoryConfigStore as createConfigStore } from "../_helpers/config-store.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FetchHandler {
  (req: RecordedRequest): Response | Promise<Response>;
}

function makeFakeFetch(handler: FetchHandler): {
  fetch: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const f: typeof fetch = async (input, init) => {
    let url: string;
    let method: string;
    const headers: Record<string, string> = {};
    let bodyText: string | undefined;

    if (input instanceof Request) {
      url = input.url;
      method = (init?.method ?? input.method ?? "GET").toUpperCase();
      input.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      // Body in Request — try to read as text.
      try {
        bodyText = await input.clone().text();
        if (bodyText.length === 0) bodyText = undefined;
      } catch {
        bodyText = undefined;
      }
    } else {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String(input);
      method = (init?.method ?? "GET").toUpperCase();
    }

    // Init headers can override.
    const rawHeaders = init?.headers;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
    } else if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = String(v);
      }
    }

    if (init?.body !== undefined && typeof init.body === "string") {
      bodyText = init.body;
    }

    let body: unknown = undefined;
    if (bodyText !== undefined) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    const rec: RecordedRequest = { url, method, headers, body };
    calls.push(rec);
    return handler(rec);
  };
  return { fetch: f, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclo-client-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ApiClient", () => {
  it("attaches Authorization header on authed requests", async () => {
    const config = createConfigStore();
    await config.save({
      api_url: "http://srv",
      access_token: "atk",
      refresh_token: "rtk",
    });
    const { fetch: f, calls } = makeFakeFetch(() =>
      jsonResponse(200, { id: "u1", email: "a@b.com" }),
    );
    const client = new ApiClient({ config, fetch: f });
    const result = await client.request(
      "get",
      "v1/me",
      z.object({ id: z.string(), email: z.string() }),
    );
    expect(result).toEqual({ id: "u1", email: "a@b.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["authorization"]).toBe("Bearer atk");
  });

  it("on 401, refreshes and retries the original request once", async () => {
    const config = createConfigStore();
    await config.save({
      api_url: "http://srv",
      access_token: "expired",
      refresh_token: "rtk",
    });

    let callIdx = 0;
    let onRefreshCalled = false;
    const { fetch: f, calls } = makeFakeFetch((req) => {
      callIdx += 1;
      if (callIdx === 1) {
        // first /v1/me — expired
        expect(req.url).toContain("/v1/me");
        expect(req.headers["authorization"]).toBe("Bearer expired");
        return jsonResponse(401, {
          error: { code: "token_expired", message: "expired" },
        });
      }
      if (callIdx === 2) {
        // refresh
        expect(req.url).toContain("/auth/refresh");
        expect(req.body).toEqual({ refresh_token: "rtk" });
        return jsonResponse(200, {
          user: { id: "u1", email: "a@b.com", display_name: null },
          access_token: "new-atk",
          refresh_token: "new-rtk",
          token_type: "bearer",
          expires_in: 1800,
        });
      }
      // retry of /v1/me with the new token
      expect(req.url).toContain("/v1/me");
      expect(req.headers["authorization"]).toBe("Bearer new-atk");
      return jsonResponse(200, { id: "u1", email: "a@b.com" });
    });

    const client = new ApiClient({
      config,
      fetch: f,
      onRefresh: () => {
        onRefreshCalled = true;
      },
    });
    const result = await client.request(
      "get",
      "v1/me",
      z.object({ id: z.string(), email: z.string() }),
    );
    expect(result.email).toBe("a@b.com");
    expect(calls).toHaveLength(3);
    expect(onRefreshCalled).toBe(true);

    // Tokens were persisted.
    const persisted = await config.load();
    expect(persisted.access_token).toBe("new-atk");
    expect(persisted.refresh_token).toBe("new-rtk");
  });

  it("on second 401 after refresh, surfaces AuthError and clears tokens", async () => {
    const config = createConfigStore();
    await config.save({
      api_url: "http://srv",
      access_token: "expired",
      refresh_token: "rtk",
    });

    let callIdx = 0;
    let authLost = false;
    const { fetch: f } = makeFakeFetch((req) => {
      callIdx += 1;
      if (callIdx === 1) {
        return jsonResponse(401, {
          error: { code: "token_expired", message: "expired" },
        });
      }
      if (callIdx === 2) {
        return jsonResponse(200, {
          user: { id: "u1", email: "a@b.com", display_name: null },
          access_token: "new-atk",
          refresh_token: "new-rtk",
          token_type: "bearer",
          expires_in: 1800,
        });
      }
      // Retry also fails — server has revoked everything.
      return jsonResponse(401, {
        error: { code: "unauthorized", message: "no" },
      });
    });

    const client = new ApiClient({
      config,
      fetch: f,
      onAuthLost: () => {
        authLost = true;
      },
    });
    await expect(
      client.request("get", "v1/me", z.object({ id: z.string() })),
    ).rejects.toBeInstanceOf(AuthError);
    expect(authLost).toBe(true);

    const persisted = await config.load();
    expect(persisted.access_token).toBeUndefined();
    expect(persisted.refresh_token).toBeUndefined();
  });

  it("when refresh itself fails, surfaces AuthError without infinite loop", async () => {
    const config = createConfigStore();
    await config.save({
      api_url: "http://srv",
      access_token: "expired",
      refresh_token: "rtk",
    });

    let callIdx = 0;
    const { fetch: f, calls } = makeFakeFetch(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return jsonResponse(401, {
          error: { code: "token_expired", message: "expired" },
        });
      }
      // refresh attempt fails
      return jsonResponse(401, {
        error: { code: "token_revoked", message: "no" },
      });
    });

    const client = new ApiClient({ config, fetch: f });
    await expect(
      client.request("get", "v1/me", z.object({ id: z.string() })),
    ).rejects.toBeInstanceOf(AuthError);
    // Exactly: original + refresh attempt — no further retries.
    expect(calls).toHaveLength(2);
  });

  it("validates response shape with zod and rejects contract drift", async () => {
    const config = createConfigStore();
    await config.save({
      api_url: "http://srv",
      access_token: "atk",
      refresh_token: "rtk",
    });
    const { fetch: f } = makeFakeFetch(() =>
      jsonResponse(200, { wrong: "shape" }),
    );
    const client = new ApiClient({ config, fetch: f });
    await expect(
      client.request(
        "get",
        "v1/me",
        z.object({ id: z.string(), email: z.string() }),
      ),
    ).rejects.toThrow();
  });
});
