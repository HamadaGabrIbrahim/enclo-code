import { z } from "zod";
import { ApiClient } from "./client.js";
import { TokenPairSchema, UserSchema, type TokenPair } from "./schemas.js";
import type { ConfigStore } from "../config/types.js";

const MeResponseSchema = UserSchema;

export async function signup(
  client: ApiClient,
  config: ConfigStore,
  args: { email: string; password: string; display_name?: string },
): Promise<TokenPair> {
  const pair = await client.publicPost("auth/signup", TokenPairSchema, args);
  await persistAuth(config, pair);
  await client.invalidateConfig();
  return pair;
}

export async function signin(
  client: ApiClient,
  config: ConfigStore,
  args: { email: string; password: string },
): Promise<TokenPair> {
  const pair = await client.publicPost("auth/signin", TokenPairSchema, args);
  await persistAuth(config, pair);
  await client.invalidateConfig();
  return pair;
}

export async function signout(
  client: ApiClient,
  config: ConfigStore,
): Promise<void> {
  const cfg = await config.load();
  if (cfg.refresh_token) {
    try {
      await client.publicPostNoBody("auth/signout", {
        refresh_token: cfg.refresh_token,
      });
    } catch {
      // Best-effort — local state still gets cleared.
    }
  }
  await config.update({
    access_token: undefined,
    refresh_token: undefined,
    user: undefined,
  });
  await client.invalidateConfig();
}

export async function fetchMe(client: ApiClient): Promise<z.infer<typeof MeResponseSchema>> {
  return client.request("get", "v1/me", MeResponseSchema);
}

async function persistAuth(config: ConfigStore, pair: TokenPair): Promise<void> {
  await config.update({
    access_token: pair.access_token,
    refresh_token: pair.refresh_token,
    user: pair.user,
  });
}
