/**
 * Permission gate (req #7).
 *
 * Every phase call and every tool call passes through here.
 *
 * The host is the single source of truth: **whenever a callback is installed it
 * is ALWAYS consulted**, for every phase and tool call, regardless of `mode`. The
 * callback decides allow/deny, may pin the per-call model, and returns the
 * UI-emission flags — and it is free to auto-allow WITHOUT any UI (e.g. an
 * "allow-all"/bypass policy just returns `{ allowed: true }`) or to surface an
 * approval prompt. This lets the host own both the permission policy and the UI
 * instead of the library short-circuiting a decision the host never sees.
 *
 * `mode` is retained only as the HEADLESS fallback used when no callback is
 * installed (in which case the gate auto-allows, so automated/library runs are
 * unblocked by default):
 *   - "bypass"        : auto-allow
 *   - "ask-all"       : auto-allow (nothing to ask — no callback)
 *   - "ask-mutations" : auto-allow
 */
import type {
  PermissionCallback,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "../types.js";

export class PermissionGate {
  constructor(
    private mode: PermissionMode = "ask-mutations",
    private callback?: PermissionCallback,
  ) {}

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setCallback(cb: PermissionCallback | undefined): void {
    this.callback = cb;
  }

  async evaluate(req: PermissionRequest): Promise<PermissionDecision> {
    // Delegate fully to the host callback whenever one exists — including in
    // bypass mode. The host applies its own per-tool policy (auto-allow vs.
    // prompt) and returns the UI-emission flags. Only when no callback is
    // installed does the gate fall back to auto-allowing (headless default).
    if (this.callback) {
      return this.callback(req);
    }
    return { allowed: true };
  }
}
