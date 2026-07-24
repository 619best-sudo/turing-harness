/**
 * Permission gate (req #7).
 *
 * Every phase call and every tool call passes through here. Three modes:
 *   - "bypass"        : never ask; auto-allow (callback not invoked)
 *   - "ask-all"       : ask for every call
 *   - "ask-mutations" : ask only for calls that mutate state
 *
 * The callback receives a {@link PermissionRequest} (including estimated
 * complexity + media refs) and returns a {@link PermissionDecision} that can also
 * pin the OpenRouter model to run the call with. If no callback is supplied, the
 * gate auto-allows.
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

  /** Whether this request needs to consult the callback under the current mode. */
  private needsAsk(req: PermissionRequest): boolean {
    if (this.mode === "bypass") return false;
    if (this.mode === "ask-all") return true;
    // ask-mutations
    return req.mutates;
  }

  async evaluate(req: PermissionRequest): Promise<PermissionDecision> {
    if (!this.needsAsk(req) || !this.callback) {
      return { allowed: true };
    }
    return this.callback(req);
  }
}
