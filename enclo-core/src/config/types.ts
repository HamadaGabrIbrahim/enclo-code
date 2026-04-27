import { z } from "zod";
import { UserSchema } from "../api/schemas.js";

/**
 * Schema and types for the persisted enclo client config (typically lives at
 * `~/.enclo/config.json` for the CLI, or in VS Code's secret/global state for
 * the editor extension). The shape is identical across consumers; what differs
 * is the storage backend, which is plugged in via `ConfigStore`.
 */
export const ConfigSchema = z.object({
  api_url: z.string().url().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  user: UserSchema.optional(),
  active_model: z.string().optional(),
  /**
   * Fraction (0..1) of the active model's context window after which the
   * client auto-compacts the conversation. Defaults to 0.7 when omitted.
   */
  compact_threshold: z.number().min(0).max(1).optional(),
  /**
   * Optional cost display ($ per 1,000,000 prompt tokens). Off when unset
   * or zero. Both prompt and completion rates must be > 0 for display.
   */
  cost_per_million_prompt_tokens: z.number().nonnegative().optional(),
  cost_per_million_completion_tokens: z.number().nonnegative().optional(),
});

export type EncloConfig = z.infer<typeof ConfigSchema>;

export interface ConfigStore {
  /** Path/identifier for the underlying storage (informational). */
  path: string;
  load(): Promise<EncloConfig>;
  save(cfg: EncloConfig): Promise<void>;
  update(patch: Partial<EncloConfig>): Promise<EncloConfig>;
  clear(): Promise<void>;
}
