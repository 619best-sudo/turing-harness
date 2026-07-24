import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../../types.js";

const TOOL_RESULT_DIR = path.join(".turing", "tool-results");

export interface LazyToolResultDetails {
  readonly kind: "lazy_tool_result";
  readonly toolName: string;
  readonly action: string;
  readonly itemCount?: number;
  readonly fullOutputPath: string;
  readonly format: "json";
}

export async function createLazyToolResultDetails(
  ctx: ToolContext,
  input: {
    readonly toolName: string;
    readonly action: string;
    readonly payload: unknown;
    readonly itemCount?: number;
  },
): Promise<LazyToolResultDetails> {
  const dir = path.join(ctx.cwd, TOOL_RESULT_DIR);
  await fs.mkdir(dir, { recursive: true });

  const fileName = `${input.toolName}-${input.action}-${Date.now()}-${randomUUID()}.json`;
  const fullOutputPath = path.join(dir, fileName);
  await fs.writeFile(fullOutputPath, JSON.stringify(input.payload, null, 2), "utf8");

  return {
    kind: "lazy_tool_result",
    toolName: input.toolName,
    action: input.action,
    itemCount: input.itemCount,
    fullOutputPath,
    format: "json",
  };
}
