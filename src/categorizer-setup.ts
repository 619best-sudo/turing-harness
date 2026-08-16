/**
 * categorizer-setup — the app-facing configuration entry for the v2
 * categorizer chain.
 *
 * This module is what a host application uses to define HOW runs are
 * categorized: which categories exist, their tools, their combined prompts,
 * their own orchestrator (driver) models, their transitions (children), what
 * each accepts from upstream, and what each must DELIVER. Ship it from a plain
 * JS config file in your app:
 *
 *   // categorizer-setup.js (your app)
 *   import {
 *     DEFAULT_CATEGORIZER_SETUP,
 *     defineCategorizer,
 *     createCategorizerSetup,
 *   } from "turing-harness/categorizer-setup";
 *
 *   const deploy = defineCategorizer({
 *     id: "deploy",
 *     name: "Deploy",
 *     description: "Ship the verified build: run the project's deploy pipeline.",
 *     systemPrompt: "You are the DEPLOY categorizer… call deliver when shipped.",
 *     tools: ["bash"],
 *     children: [],                    // terminal: summarise afterwards
 *     accepts: { from: ["activity_inspect"] },
 *     returns: { kind: "summary", description: "The deploy result" },
 *     model: "qwen/qwen3-coder",       // this categorizer's orchestrator model
 *   });
 *
 *   export const setup = createCategorizerSetup({
 *     categories: [...DEFAULT_CATEGORIZER_SETUP.categories, deploy],
 *     doubtModel: "tencent/hy3",       // the big model clearing_doubt consults
 *     maxHops: 8,
 *   });
 *
 *   // then: new Harness({ categorizerSetup: setup, ... })  — or per session.
 *
 * The default setup (conversation / read / write_edit / activity_inspect with
 * the standard read → write_edit ↔ activity_inspect → summarise graph) is
 * exported ready-to-extend: add a category, wire ids into `children`/`accepts`,
 * and the router picks it up with no other changes.
 */

export {
  defineCategorizer,
  createCategorizerSetup,
  createDefaultCategorizers,
  getCategory,
  entryCategories,
  DEFAULT_CATEGORIZER_SETUP,
  DEFAULT_GLOBAL_TOOLS,
} from "./categorizer/setup.js";
export type { CategorizerSetup } from "./categorizer/setup.js";
export type {
  CategorizerDefinition,
  CategorizerId,
  CategorizerAcceptSpec,
  CategorizerReturnSpec,
} from "./categorizer/types.js";
export {
  buildCategorizerSystemPrompt,
  DEFAULT_CATEGORIZER_PROMPTS,
  DEFAULT_ROUTER_PROMPT,
} from "./categorizer/prompts.js";
export { DEFAULT_DOUBT_MODEL } from "./categorizer/clearing-doubt.js";
