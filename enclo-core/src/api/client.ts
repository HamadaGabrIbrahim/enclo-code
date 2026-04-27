import ky, { type KyInstance, HTTPError } from "ky";
import { z } from "zod";
import { ErrorEnvelopeSchema, TokenPairSchema, type TokenPair } from "./schemas.js";
import type { ConfigStore, EncloConfig } from "../config/types.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  config: ConfigStore;
  /** Override the fetch impl (handy for tests / Node 20 polyfills). */
  fetch?: typeof fetch;
  /** Called after a successful refresh, before retry. Mostly for tests. */
  onRefresh?: (pair: TokenPair) => void;
  /** Called when refresh fails and the user must re-signin. */
  onAuthLost?: () => void;
}

interface RefreshResult {
  ok: true;
  cfg: EncloConfig;
}

/**
 * Strongly-typed wrapper around ky that:
 *   - injects Authorization: Bearer <access_token>
 *   - on a single 401, posts to /auth/refresh, persists new tokens,
 *     then transparently retries the original request once.
 *   - on a second 401 (or refresh failure), surfaces an AuthError and
 *     calls `onAuthLost` so the UI can force re-signin.
 *
 * `requestStream` returns the raw Response (used by the SSE chat call) instead
 * of going through ky's JSON parsing, but reuses the same auth/refresh logic.
 */
export class ApiClient {
  private readonly opts: ApiClientOptions;
  private cachedCfg: EncloConfig | null = null;
  private refreshInFlight: Promise<RefreshResult | null> | null = null;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
  }

  async getConfig(): Promise<EncloConfig> {
    if (this.cachedCfg) return this.cachedCfg;
    this.cachedCfg = await this.opts.config.load();
    return this.cachedCfg;
  }

  async invalidateConfig(): Promise<EncloConfig> {
    this.cachedCfg = await this.opts.config.load();
    return this.cachedCfg;
  }

  /** ky instance with current base URL but NO auth header — used for /auth/*. */
  private async publicKy(): Promise<KyInstance> {
    const cfg = await this.getConfig();
    if (!cfg.api_url) throw new Error("api_url not configured");
    return ky.create({
      prefixUrl: cfg.api_url,
      timeout: 30_000,
      retry: 0,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  /** ky instance with current Authorization header. */
  private async authedKy(): Promise<KyInstance> {
    const cfg = await this.getConfig();
    if (!cfg.api_url) throw new Error("api_url not configured");
    if (!cfg.access_token) throw new AuthError("not signed in", "unauthorized");
    return ky.create({
      prefixUrl: cfg.api_url,
      timeout: 30_000,
      retry: 0,
      headers: { Authorization: `Bearer ${cfg.access_token}` },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  /**
   * Issue a JSON request with auth. On 401, attempt one refresh+retry.
   * Schema-validates the response.
   */
  async request<T extends z.ZodTypeAny>(
    method: "get" | "post" | "delete",
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const doRequest = async (): Promise<unknown> => {
      const k = await this.authedKy();
      const opts: { json?: unknown } = body !== undefined ? { json: body } : {};
      return k(path, { method, ...opts }).json();
    };

    try {
      const json = await doRequest();
      return schema.parse(json);
    } catch (err) {
      if (await this.is401(err)) {
        const refreshed = await this.tryRefresh();
        if (refreshed) {
          try {
            const json = await doRequest();
            return schema.parse(json);
          } catch (err2) {
            await this.maybeForceSignin(err2);
            throw await this.toApiError(err2);
          }
        }
        await this.maybeForceSignin(err);
        throw await this.toApiError(err);
      }
      throw await this.toApiError(err);
    }
  }

  /**
   * Issue a request expecting a streamed body (text/event-stream). Returns
   * the raw Response so the caller can read `.body`. Performs the same
   * 401→refresh→retry dance.
   */
  async requestStream(
    method: "post",
    path: string,
    body: unknown,
  ): Promise<Response> {
    const doRequest = async (): Promise<Response> => {
      const k = await this.authedKy();
      return k(path, {
        method,
        json: body,
        headers: { Accept: "text/event-stream" },
      });
    };

    try {
      return await doRequest();
    } catch (err) {
      if (await this.is401(err)) {
        const refreshed = await this.tryRefresh();
        if (refreshed) {
          try {
            return await doRequest();
          } catch (err2) {
            await this.maybeForceSignin(err2);
            throw await this.toApiError(err2);
          }
        }
        await this.maybeForceSignin(err);
        throw await this.toApiError(err);
      }
      throw await this.toApiError(err);
    }
  }

  /** Plain (no auth) JSON POST — used for /auth/signup, /auth/signin. */
  async publicPost<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    body: unknown,
  ): Promise<z.infer<T>> {
    try {
      const k = await this.publicKy();
      const json = await k.post(path, { json: body }).json();
      return schema.parse(json);
    } catch (err) {
      throw await this.toApiError(err);
    }
  }

  /** Plain (no auth) POST returning Response, used for /auth/signout. */
  async publicPostNoBody(path: string, body: unknown): Promise<Response> {
    try {
      const k = await this.publicKy();
      return await k.post(path, { json: body });
    } catch (err) {
      throw await this.toApiError(err);
    }
  }

  private async is401(err: unknown): Promise<boolean> {
    return err instanceof HTTPError && err.response.status === 401;
  }

  /**
   * Attempt to refresh tokens. De-duplicates concurrent calls. Returns null on
   * failure (caller should propagate the original 401).
   */
  private async tryRefresh(): Promise<RefreshResult | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async (): Promise<RefreshResult | null> => {
      try {
        const cfg = await this.getConfig();
        if (!cfg.refresh_token) return null;
        const k = await this.publicKy();
        const json = await k
          .post("auth/refresh", { json: { refresh_token: cfg.refresh_token } })
          .json();
        const pair = TokenPairSchema.parse(json);
        const next = await this.opts.config.update({
          access_token: pair.access_token,
          refresh_token: pair.refresh_token,
          user: pair.user,
        });
        this.cachedCfg = next;
        this.opts.onRefresh?.(pair);
        return { ok: true, cfg: next };
      } catch {
        return null;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private async maybeForceSignin(err: unknown): Promise<void> {
    if (await this.is401(err)) {
      await this.opts.config.update({
        access_token: undefined,
        refresh_token: undefined,
      });
      this.cachedCfg = await this.opts.config.load();
      this.opts.onAuthLost?.();
    }
  }

  private async toApiError(err: unknown): Promise<Error> {
    if (err instanceof HTTPError) {
      const status = err.response.status;
      try {
        const body = await err.response.clone().json();
        const parsed = ErrorEnvelopeSchema.safeParse(body);
        if (parsed.success) {
          if (status === 401) {
            return new AuthError(parsed.data.error.message, parsed.data.error.code);
          }
          return new ApiError(
            parsed.data.error.message,
            parsed.data.error.code,
            status,
          );
        }
      } catch {
        /* fallthrough */
      }
      if (status === 401) return new AuthError("unauthorized", "unauthorized");
      return new ApiError(`HTTP ${status}`, "http_error", status);
    }
    if (err instanceof Error) return err;
    return new Error(String(err));
  }
}
