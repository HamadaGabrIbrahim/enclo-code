/**
 * Centralized color/style tokens for the TUI.
 *
 * Design intent: most text renders in the terminal's default foreground
 * (whatever the user's theme provides). Color is reserved for semantic
 * meaning — accent for branding/active state, success/error/warn for tool
 * outcomes, and muted gray for metadata and chrome. Avoid coloring whole
 * blocks of body text; that's how Claude Code keeps the surface calm.
 */

const ACCENT = "#d97757";          // warm peach — primary brand color
const ACCENT_DIM = "#a85b3f";      // same hue, darker — for secondary use
const MUTED = "gray";              // borders, metadata, hints
const TEXT = undefined;            // undefined means "use terminal default"

export const theme = {
  // Brand / chrome
  accent: ACCENT,
  accentDim: ACCENT_DIM,
  border: MUTED,
  muted: MUTED,
  text: TEXT,

  // Roles in the chat transcript
  role: {
    user: MUTED,         // dim — the user knows what they typed
    assistant: ACCENT,   // accent — draws the eye to the response
    system: MUTED,       // dim — metadata, not a turn
    tool: MUTED,         // dim — tool messages are scaffolding
  },

  // Semantic
  success: "green",
  error: "red",
  warn: "yellow",
  info: "blue",
  reasoning: MUTED,

  // Tool status
  tool: {
    pending: MUTED,
    done: "green",
    denied: "red",
    error: "red",
    /** Live stdout while a tool is running. Cyan reads as "in flight". */
    partialStdout: "cyan",
    partialStderr: "red",
  },
} as const;
