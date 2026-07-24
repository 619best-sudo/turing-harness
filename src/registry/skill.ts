/**
 * Skill registration (req #3, "skill" providers).
 *
 * A skill is a bundle of tools/behaviour packaged as a named capability. Unlike an
 * MCP server (an external process reached over stdio, see {@link connectMcpServer}),
 * a skill's tools run in-process. This helper gives skills a first-class, typed
 * registration path so a host doesn't have to hand-assemble a {@link ProviderInput}:
 *
 *   registry.add(defineSkill({
 *     id: "skill:docs",
 *     name: "docs-helper",
 *     description: "Fetches and summarizes reference docs for planning.",
 *     phases: ["plan"],               // which 4P phase(s) this skill serves
 *     tools: [docsFetchTool, ...],
 *   }));
 *
 * `phases` is optional: when omitted the registry infers phases per-tool from the
 * 4P categorizer. Declaring it explicitly is preferred for skills, because a
 * skill's intent (research vs. mutation vs. verification) is usually known to its
 * author and should not be guessed from tool names.
 */
import type { AgentTool, Phase } from "../types.js";
import type { ProviderInput } from "./registry.js";

export interface SkillDefinition {
  /** Unique provider id (convention: prefix with "skill:"). */
  id: string;
  /** Display name. */
  name: string;
  /** Human/LLM description; used by Prepare to route the skill to phases. */
  description: string;
  /** The tools this skill exposes. */
  tools: AgentTool[];
  /** Which 4P phase(s) this skill serves. Omit to infer per-tool. */
  phases?: Phase[];
  /** Whether the skill's tools mutate state (default false — skills are usually
   *  read/assist). Applied to any tool that doesn't declare its own `mutates`. */
  mutates?: boolean;
  /** "internal" (bundled) or "external" (host/user-loaded). Default "external". */
  source?: "internal" | "external";
  /** Optional lifecycle hook to release resources. */
  dispose?: () => void | Promise<void>;
  /** Freeform metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Build a {@link ProviderInput} for a skill, ready to hand to `registry.add(...)`.
 * When `phases` is declared it is applied both to the provider and to every tool
 * that doesn't already carry its own `phases`, so the skill lands in exactly the
 * phase(s) its author intended rather than the categorizer's guess.
 */
export function defineSkill(def: SkillDefinition): ProviderInput {
  const tools: AgentTool[] = def.tools.map((tool) => ({
    ...tool,
    mutates: tool.mutates ?? def.mutates ?? false,
    ...(def.phases && !tool.phases?.length ? { phases: [...def.phases] } : {}),
  }));
  return {
    id: def.id,
    kind: "skill",
    source: def.source ?? "external",
    name: def.name,
    description: def.description,
    tools,
    ...(def.phases?.length ? { phases: [...def.phases] } : {}),
    ...(def.dispose ? { dispose: def.dispose } : {}),
    metadata: { ...(def.metadata ?? {}), skill: true },
  };
}
