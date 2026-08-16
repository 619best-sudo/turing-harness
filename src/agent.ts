/**
 * pi-compatible Agent facade (req #2).
 *
 * Mirrors the surface of `@mariozechner/pi-agent`'s `Agent` class — `subscribe`,
 * `prompt(input, attachments?)`, `state`, `setModel`, `setThinkingLevel`, `abort`,
 * `reset` — and emits the same {@link AgentEvent} stream, so a pi UI can drive this
 * harness with minimal changes. Under the hood, `prompt` runs the 4P chain.
 */
import type {
  AgentEvent,
  AskUserQuestionRequest,
  AskUserQuestionResult,
  AppMessage,
  Attachment,
  MediaRef,
  Message,
  Phase,
  PhaseResult,
  PlanSet,
  RunLoopResult,
  RunStep,
  ThreadFollowUpContext,
  VerificationReport,
  ReproductionReport,
  ThreadRunSnapshot,
  ThinkingLevel,
  TranscriptMode,
  UserMessage,
} from "./types.js";
import type { ChainResult } from "./orchestrator/orchestrator.js";
import { buildUserContent, refsFromAttachments } from "./multimodal/attachment.js";

/**
 * The minimal session surface an Agent drives. Both {@link Session} and the
 * default-session {@link Harness} satisfy it, so an Agent can be bound to either
 * — and, crucially, to a *specific* session for parallel/multi-session apps.
 */
export interface AgentHost {
  subscribe(fn: (e: AgentEvent) => void): () => void;
  /** Flat loop driver — the primary entry point (pi-style loop + summary). */
  run(task: string, opts?: { signal?: AbortSignal; askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>; followUpContext?: ThreadFollowUpContext; transcriptMode?: TranscriptMode; emitReasoning?: boolean; emitText?: boolean; images?: Array<{ path: string; mimeType: string }>; skipPlan?: boolean; maxStepsPerStep?: number; isBugFix?: boolean }): Promise<RunLoopResult>;
  runChain(task: string, opts?: { signal?: AbortSignal; askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>; followUpContext?: ThreadFollowUpContext; transcriptMode?: TranscriptMode }): Promise<ChainResult>;
  runPhase(phase: Phase, task: string, opts?: { priorRefs?: MediaRef[]; signal?: AbortSignal; askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>; followUpContext?: ThreadFollowUpContext; transcriptMode?: TranscriptMode }): Promise<PhaseResult>;
  orchestrator: {
    setModel(target: Phase | "orchestrator", slug: string | undefined): void;
    setReasoning(target: Phase, level: ThinkingLevel | undefined): void;
  };
  readonly threadSnapshot?: ThreadRunSnapshot;
  clearThreadSnapshot?(): void;
}

/** pi-agent-compatible state shape (subset + run extras). */
export interface HarnessAgentState {
  systemPrompt: string;
  /** Current orchestrator/default model slug. */
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: AppMessage[];
  isStreaming: boolean;
  streamMessage: Message | null;
  error?: string;
  /** Whether the last run verified its written files. Set on BOTH the flat-loop
   * `run` path (via the verify-what-you-wrote gate) and the legacy 4P chain. */
  lastVerified?: boolean;
  /** Structured verification report from the flat loop's verify gate, if any. */
  lastVerification?: VerificationReport;
  /** Reproduce-gate report from the last bug-fix run, if any. */
  lastReproduction?: ReproductionReport;
  pendingUserQuestion?: AskUserQuestionRequest;
  /** Legacy 4P per-phase results (still populated when run via runChain/runPhase). */
  lastPhaseResults?: Partial<Record<Phase, PhaseResult>>;
  /** End-of-run summary from the flat loop driver. */
  lastRunSummary?: string;
  /** Per-step progress from the flat loop driver (with isCompleted). */
  lastSteps?: RunStep[];
  /** The structured plan the flat loop's last run produced (if any). */
  lastPlanSet?: PlanSet;
  lastThreadSnapshot?: ThreadRunSnapshot;
}

export interface HarnessAgentOptions {
  systemPrompt?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Run mode: full 4P chain (default) or a single phase per prompt. */
  mode?: "chain" | Phase;
  transcriptMode?: TranscriptMode;
  /**
   * Emit the model's reasoning to the host. Defaults to `false` under
   * `transcriptMode: "compact"`, `true` otherwise.
   *
   * Set it when you want a compact transcript that still shows thinking. Compact
   * on its own seeds emission off, and the only thing that can turn it back on
   * mid-run is a tool call's permission decision — so the first turn's reasoning
   * is gone before any callback runs, and a turn that calls no tools never
   * emits any. `thinkingLevel` controls whether the model REASONS; this controls
   * whether you SEE it. Both have to be on.
   */
  emitReasoning?: boolean;
  /** Same, for assistant text. Same defaults. */
  emitText?: boolean;
  /**
   * Optional hard cap on tool-call turns per step. Unset (the default) runs to
   * completion.
   *
   * Setting it is riskier here than it looks: `prompt()` runs with
   * `skipPlan: true`, so there is exactly ONE work loop and this becomes the
   * budget for the WHOLE task — the `create_plan` turn plus every step of the
   * plan it produced. A value sized for a single step will truncate a multi-step
   * plan partway through and end the run early.
   */
  maxStepsPerStep?: number;
  /**
   * Whether runs from this agent are bug fixes. Enables the
   * reproduce-before-you-edit gate; see `OrchestratorConfig.isBugFix`.
   */
  isBugFix?: boolean;
}

export class HarnessAgent {
  private _state: HarnessAgentState;
  private listeners = new Set<(e: AgentEvent) => void>();
  private unsubscribe: () => void;
  private abortController?: AbortController;
  private running?: Promise<void>;
  private mode: "chain" | Phase;
  private transcriptMode: TranscriptMode;
  private emitReasoning?: boolean;
  private emitText?: boolean;
  private maxStepsPerStep?: number;
  private isBugFix?: boolean;

  constructor(
    private readonly harness: AgentHost,
    opts: HarnessAgentOptions = {},
  ) {
    this._state = {
      systemPrompt: opts.systemPrompt ?? "",
      // The Agent facade's driver, kept in step with `DEFAULT_PHASE_MODELS`.
      model: opts.model ?? "xiaomi/mimo-v2.5",
      thinkingLevel: opts.thinkingLevel ?? "medium",
      messages: [],
      isStreaming: false,
      streamMessage: null,
      lastThreadSnapshot: this.harness.threadSnapshot,
    };
    this.mode = opts.mode ?? "chain";
    this.transcriptMode = opts.transcriptMode ?? "full";
    this.emitReasoning = opts.emitReasoning;
    this.emitText = opts.emitText;
    this.maxStepsPerStep = opts.maxStepsPerStep;
    this.isBugFix = opts.isBugFix;
    if (opts.model) this.harness.orchestrator.setModel("orchestrator", opts.model);
    // Propagate the (effective) thinking level into the orchestrator so every
    // phase model is actually *asked* to reason (each model still gates on its
    // own `reasoning` capability). Without this the model never produces
    // thinking tokens, so there is nothing for the permission `reasoning` flag
    // to emit. Uses the resolved level (defaults to "medium") so a host that
    // omits `thinkingLevel` still gets reasoning; "off" disables it.
    for (const phase of ["prepare", "plan", "perform", "perfect"] as Phase[]) {
      this.harness.orchestrator.setReasoning(phase, this._state.thinkingLevel);
    }

    // Forward orchestrator events to our subscribers and fold into state.
    this.unsubscribe = this.harness.subscribe((e) => this.onOrchestratorEvent(e));
  }

  get state(): HarnessAgentState {
    return this._state;
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setSystemPrompt(v: string): void {
    this._state.systemPrompt = v;
  }

  /** Set the orchestrator (default) model. Per-phase models via setPhaseModel. */
  setModel(slug: string): void {
    this._state.model = slug;
    this.harness.orchestrator.setModel("orchestrator", slug);
  }

  setPhaseModel(phase: Phase, slug: string | undefined): void {
    this.harness.orchestrator.setModel(phase, slug);
  }

  setThinkingLevel(l: ThinkingLevel): void {
    this._state.thinkingLevel = l;
    for (const phase of ["prepare", "plan", "perform", "perfect"] as Phase[]) {
      this.harness.orchestrator.setReasoning(phase, l);
    }
  }

  clearMessages(): void {
    this._state.messages = [];
  }

  abort(): void {
    this.abortController?.abort();
  }

  reset(): void {
    this.abort();
    this._state.messages = [];
    this._state.error = undefined;
    this._state.lastVerified = undefined;
    this._state.lastVerification = undefined;
    this._state.lastReproduction = undefined;
    this._state.pendingUserQuestion = undefined;
    this._state.lastPhaseResults = undefined;
    this._state.lastRunSummary = undefined;
    this._state.lastSteps = undefined;
    this._state.lastPlanSet = undefined;
    this._state.lastThreadSnapshot = undefined;
    this._state.streamMessage = null;
    this._state.isStreaming = false;
    this.harness.clearThreadSnapshot?.();
  }

  waitForIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * Prompt the agent. Appends the user message (with attachments carried by
   * reference), runs the flat loop driver (or a single legacy phase, when
   * `mode` is set to a specific phase), and resolves when done.
   */
  /**
   * Run one turn.
   *
   * `opts.planMode` turns the orchestrator's PLANNING TURN back on for this
   * prompt: the model first emits a plan (or calls `create_plan`, which routes
   * through the host's `planApproval`), and each approved step then runs in its
   * own focused sub-loop. Off by default — see the `skipPlan` note below for
   * why a flat loop is the better default for a single ask.
   */
  async prompt(
    input: string,
    attachments?: Attachment[],
    opts: { planMode?: boolean } = {},
  ): Promise<void> {
    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.error = undefined;
    this._state.pendingUserQuestion = undefined;
    this._state.lastPhaseResults = undefined;
    this._state.lastRunSummary = undefined;
    this._state.lastSteps = undefined;
    this._state.lastVerified = undefined;
    this._state.lastVerification = undefined;
    this._state.lastReproduction = undefined;
    this.emit({ type: "agent_start" });

    const content = await buildUserContent(input, attachments, false);
    const userMessage: UserMessage & { attachments?: Attachment[] } = {
      role: "user",
      content,
      timestamp: Date.now(),
      attachments,
    };
    this._state.messages.push(userMessage);

    const refs = refsFromAttachments(attachments);
    // The host installs the askUserQuestion callback on the session/harness
    // itself (mirroring setPermissionCallback); the harness propagates it
    // through to the loop. The agent does not need to forward it here.
    const run = (async () => {
      try {
        if (this.mode === "chain") {
          // Primary path: the flat loop driver. Image attachments are forwarded
          // so a write/edit can author files from them via a vision model.
          const scopedResult: RunLoopResult = await this.harness.run(input, {
            signal: this.abortController!.signal,
            transcriptMode: this.transcriptMode,
            ...(this.emitReasoning !== undefined ? { emitReasoning: this.emitReasoning } : {}),
            ...(this.emitText !== undefined ? { emitText: this.emitText } : {}),
            // Default: skip the planning turn, so the model doesn't split a
            // single ask (e.g. "find a price on this site") into plan tasks that
            // each restart the browser from scratch. In a flat tool loop the
            // model can still work across many turns — it just won't emit a
            // synthetic plan that creates separate sub-runs.
            //
            // `planMode` opts back in, for a request big enough that the user
            // WANTS to see and approve the decomposition before work starts.
            skipPlan: !opts.planMode,
            // With `skipPlan`, this single budget covers the whole task — the
            // `create_plan` turn plus every step of the resulting plan.
            ...(this.maxStepsPerStep ? { maxStepsPerStep: this.maxStepsPerStep } : {}),
            ...(this.isBugFix ? { isBugFix: true } : {}),
            ...(imageRefsFromAttachments(attachments).length
              ? { images: imageRefsFromAttachments(attachments) }
              : {}),
            ...(fileRefsFromAttachments(attachments).length
              ? { files: fileRefsFromAttachments(attachments) }
              : {}),
          });
          this._state.pendingUserQuestion = scopedResult.pendingUserQuestion;
          this._state.lastRunSummary = scopedResult.summary;
          this._state.lastSteps = scopedResult.steps;
          this._state.lastPlanSet = scopedResult.planSet;
          this._state.lastThreadSnapshot = scopedResult.threadSnapshot;
          // Surface verification state from the flat-loop verify gate. `verified`
          // is undefined when the gate didn't run (no writes / conversational).
          if (typeof scopedResult.verified === "boolean") {
            this._state.lastVerified = scopedResult.verified;
          }
          if (scopedResult.verification) {
            this._state.lastVerification = scopedResult.verification;
          }
          if (scopedResult.reproduction) {
            this._state.lastReproduction = scopedResult.reproduction;
          }
          // Surface a hard failure (LLM/transport/tool error) so consumers see it
          // instead of an empty, successful-looking turn. A user abort is not one.
          if (scopedResult.error) this._state.error = scopedResult.error;
        } else {
          const r = await this.harness.runPhase(this.mode, input, {
            priorRefs: refs,
            signal: this.abortController!.signal,
            transcriptMode: this.transcriptMode,
          });
          this._state.lastVerified = r.verified;
          this._state.lastPhaseResults = { [this.mode]: r };
          if (r.error && r.error !== "aborted") this._state.error = r.error;
          this._state.lastThreadSnapshot = this.harness.threadSnapshot;
        }
      } catch (err) {
        this._state.error = err instanceof Error ? err.message : String(err);
      } finally {
        this._state.isStreaming = false;
        this._state.streamMessage = null;
        this.emit({ type: "agent_end", messages: this._state.messages });
      }
    })();
    this.running = run;
    await run;
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private onOrchestratorEvent(e: AgentEvent): void {
    // Fold streamed messages into state.messages (turn_end carries the finished
    // assistant message + its tool results, in order).
    if (e.type === "message_start" || e.type === "message_update") {
      this._state.streamMessage = e.message as Message;
    } else if (e.type === "turn_end") {
      if (this.transcriptMode === "compact") {
        const assistantMessage = e.message as Message;
        // `thinking` counts alongside text/toolCall: compact drops turns with
        // NOTHING to render, and a turn that reasoned is not nothing. Excluding
        // it here meant a reasoning-only turn vanished from the host transcript
        // even when the run was emitting reasoning — the second place thinking
        // was silently lost, after the loop's emission gate.
        const hasRenderableContent =
          assistantMessage.role === "assistant" &&
          assistantMessage.content.some(
            (entry) => entry.type === "text" || entry.type === "toolCall" || entry.type === "thinking",
          );
        if (hasRenderableContent) {
          this._state.messages.push(assistantMessage);
        }
      } else {
        this._state.messages.push(e.message);
      }
      // Tool results belong in the render transcript in BOTH modes. `compact`
      // trims which assistant TURNS are kept (skipping empty ones), not the
      // results of the tool calls it keeps — a toolCall whose result is dropped
      // leaves the host unable to show what the tool returned (a read's file, an
      // edit's diff), so its UI has nothing to expand once the run completes.
      // This costs no prompt tokens: `state.messages` is the host-facing render
      // transcript only. The model's context is the loop's own `context.messages`,
      // and follow-up continuity uses the structured `lastThreadSnapshot`.
      for (const tr of e.toolResults) this._state.messages.push(tr);
      this._state.streamMessage = null;
    }
    // Re-emit every event (including agent_start/agent_end from prompt()).
    this.emit(e);
  }

  private emit(e: AgentEvent): void {
    // Isolate subscriber exceptions: a throwing host listener (UI mapper, tracker)
    // must not propagate into prompt()/the run loop and abort it mid-way.
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a buggy subscriber only loses its own event, never the run */
      }
    }
  }
}

/**
 * Extract image attachments as `{path, mimeType}` refs for the loop's vision
 * authoring. Only image attachments with a resolvable address (ref.uri or a
 * fileName) are forwarded; non-image attachments are ignored.
 */
function imageRefsFromAttachments(attachments?: Attachment[]): Array<{ path: string; mimeType: string }> {
  if (!attachments?.length) return [];
  const out: Array<{ path: string; mimeType: string }> = [];
  for (const att of attachments) {
    if (att.type !== "image") continue;
    const p = att.ref?.uri ?? att.fileName;
    if (p) out.push({ path: p, mimeType: att.mimeType || "image/png" });
  }
  return out;
}

/**
 * Extract NON-image attachments as `{path, mimeType}` refs so the loop can see
 * them. This is the inverse of {@link imageRefsFromAttachments}: documents,
 * audio, video, and data files the user attached. Without it, a spec.pdf, a
 * voice memo, a video, or a data.csv attached to a prompt is invisible to the
 * loop model — it never learns the file exists, so it cannot `read` or
 * `media_analysis` it. The orchestrator lists these as AVAILABLE FILES; document
 * types are additionally triaged so their text reaches authoring.
 */
function fileRefsFromAttachments(attachments?: Attachment[]): Array<{ path: string; mimeType: string }> {
  if (!attachments?.length) return [];
  const out: Array<{ path: string; mimeType: string }> = [];
  for (const att of attachments) {
    if (att.type === "image") continue;
    const p = att.ref?.uri ?? att.fileName;
    if (p) out.push({ path: p, mimeType: att.mimeType || "application/octet-stream" });
  }
  return out;
}
