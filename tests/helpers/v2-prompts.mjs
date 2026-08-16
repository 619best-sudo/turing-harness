/**
 * Shared v2 prompt fixtures for tests.
 *
 * The stitched system prompt of each built-in categorizer with EVERY guidance
 * block included (no tool gating) — the moral equivalent of the retired
 * `LOOP_SYSTEM_PROMPT`/`PHASE_PROMPTS` static exports the 4P-era tests used.
 */
import {
  buildCategorizerSystemPrompt,
  DEFAULT_CATEGORIZER_PROMPTS,
  DEFAULT_CATEGORIZER_SETUP,
} from "../../dist/index.js";

const def = (id) => DEFAULT_CATEGORIZER_SETUP.categories.find((c) => c.id === id);

export const WORK_PROMPT = buildCategorizerSystemPrompt({
  id: "write_edit",
  systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.write_edit,
});
export const READ_PROMPT = buildCategorizerSystemPrompt({
  id: "read",
  systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.read,
});
export const INSPECT_PROMPT = buildCategorizerSystemPrompt({
  id: "activity_inspect",
  systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.activity_inspect,
});
export const CONVERSATION_PROMPT_STITCHED = buildCategorizerSystemPrompt({
  id: "conversation",
  systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.conversation,
});

/** All four stitched prompts, for tests that assert guidance placement. */
export const CATEGORIZER_PROMPTS = {
  conversation: CONVERSATION_PROMPT_STITCHED,
  read: READ_PROMPT,
  write_edit: WORK_PROMPT,
  activity_inspect: INSPECT_PROMPT,
};

export { DEFAULT_CATEGORIZER_SETUP, def as categorizerDef };

/** Loop-prompt equivalent: the write_edit categorizer, tool-gated. */
export function buildWorkPrompt(toolNames, opts) {
  return buildCategorizerSystemPrompt({ id: "write_edit", systemPrompt: DEFAULT_CATEGORIZER_PROMPTS.write_edit }, toolNames, opts);
}

/** Phase-name compatibility shim for tests: map old 4P names → categorizers. */
export function buildPhaseLikePrompt(phase, toolNames, opts) {
  const map = {
    prepare: "read",
    plan: "read",
    perform: "write_edit",
    perfect: "activity_inspect",
  };
  const id = map[phase] ?? "write_edit";
  return buildCategorizerSystemPrompt({ id, systemPrompt: DEFAULT_CATEGORIZER_PROMPTS[id] }, toolNames, opts);
}
