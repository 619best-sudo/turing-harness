/**
 * categorizer-setup.js — repo-root re-export of the categorizer configuration
 * entry, for hosts that consume the built harness as plain JavaScript.
 *
 * Same surface as the package export "turing-harness/categorizer-setup":
 *   DEFAULT_CATEGORIZER_SETUP  — the four built-in categories, ready to extend
 *   defineCategorizer          — validate one category definition
 *   createCategorizerSetup     — build a full validated setup
 *   DEFAULT_DOUBT_MODEL        — the big model clearing_doubt consults
 *
 * Example (your own setup file):
 *
 *   import {
 *     DEFAULT_CATEGORIZER_SETUP,
 *     defineCategorizer,
 *     createCategorizerSetup,
 *   } from "./categorizer-setup.js";
 */
export {
  defineCategorizer,
  createCategorizerSetup,
  createDefaultCategorizers,
  getCategory,
  entryCategories,
  DEFAULT_CATEGORIZER_SETUP,
  DEFAULT_GLOBAL_TOOLS,
} from "./dist/categorizer-setup.js";
