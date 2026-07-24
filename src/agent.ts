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
  AppMessage,
  Attachment,
  MediaRef,
  Message,
  Phase,
  PhaseResult,
  ThreadFollowUpContext,
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
  runChain(task: string, opts?: { signal?: AbortSignal; askUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>; followUpContext?: ThreadFollowUpContext; transcriptMode?: TranscriptMode }): Promise<ChainResult>;
  runPhase(phase: Phase, task: string, opts?: { priorRefs?: MediaRef[]; signal?: AbortSignal; askUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>; followUpContext?: ThreadFollowUpContext; transcriptMode?: TranscriptMode }): Promise<PhaseResult>;
  orchestrator: { setModel(target: Phase | "orchestrator", slug: string | undefined): void };
  readonly threadSnapshot?: ThreadRunSnapshot;
  clearThreadSnapshot?(): void;
}

/** pi-agent-compatible state shape (subset + 4P extras). */
export interface HarnessAgentState {
  systemPrompt: string;
  /** Current orchestrator/default model slug. */
  model: string;
  thinkingLevel: ThinkingLevel;
  messages: AppMessage[];
  isStreaming: boolean;
  streamMessage: Message | null;
  error?: string;
  /** Whether the last chain run verified in the Perfect phase. */
  lastVerified?: boolean;
  pendingUserQuestion?: AskUserQuestionRequest;
  lastPhaseResults?: Partial<Record<Phase, PhaseResult>>;
  lastThreadSnapshot?: ThreadRunSnapshot;
}

export interface HarnessAgentOptions {
  systemPrompt?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Run mode: full 4P chain (default) or a single phase per prompt. */
  mode?: "chain" | Phase;
  transcriptMode?: TranscriptMode;
}

export class HarnessAgent {
  private _state: HarnessAgentState;
  private listeners = new Set<(e: AgentEvent) => void>();
  private unsubscribe: () => void;
  private abortController?: AbortController;
  private running?: Promise<void>;
  private mode: "chain" | Phase;
  private transcriptMode: TranscriptMode;

  constructor(
    private readonly harness: AgentHost,
    opts: HarnessAgentOptions = {},
  ) {
    this._state = {
      systemPrompt: opts.systemPrompt ?? "",
      model: opts.model ?? "poolside/laguna-xs-2.1",
      thinkingLevel: opts.thinkingLevel ?? "medium",
      messages: [],
      isStreaming: false,
      streamMessage: null,
      lastThreadSnapshot: this.harness.threadSnapshot,
    };
    this.mode = opts.mode ?? "chain";
    this.transcriptMode = opts.transcriptMode ?? "full";
    if (opts.model) this.harness.orchestrator.setModel("orchestrator", opts.model);

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
    this._state.pendingUserQuestion = undefined;
    this._state.lastPhaseResults = undefined;
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
   * reference), runs the 4P chain (or a single phase), and resolves when done.
   */
  async prompt(input: string, attachments?: Attachment[]): Promise<void> {
    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.error = undefined;
    this._state.pendingUserQuestion = undefined;
    this._state.lastPhaseResults = undefined;
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
    // through to every phase. The agent does not need to forward it here.
    const run = (async () => {
      try {
        if (this.mode === "chain") {
          const scopedResult = await this.harness.runChain(input, {
            signal: this.abortController!.signal,
            transcriptMode: this.transcriptMode,
          });
          this._state.lastVerified = scopedResult.phases.perfect?.verified;
          this._state.pendingUserQuestion = scopedResult.pendingUserQuestion;
          this._state.lastPhaseResults = scopedResult.phases;
          this._state.lastThreadSnapshot = scopedResult.threadSnapshot;
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
        const hasAssistantTextOrToolCalls =
          assistantMessage.role === "assistant" &&
          assistantMessage.content.some((entry) => entry.type === "text" || entry.type === "toolCall");
        if (hasAssistantTextOrToolCalls) {
          this._state.messages.push(assistantMessage);
        }
      } else {
        this._state.messages.push(e.message);
        for (const tr of e.toolResults) this._state.messages.push(tr);
      }
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
