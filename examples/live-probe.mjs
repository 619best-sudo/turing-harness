/**
 * Live connectivity + tool-calling probe against OpenRouter.
 * Confirms the API key + model work AND that the model supports function calling
 * (the whole harness depends on tool calls).
 *
 * Run:  OPENROUTER_API_KEY=... node examples/live-probe.mjs
 */
import { complete, resolveModel } from "../dist/index.js";

const SLUG = process.env.HARNESS_MODEL ?? "bytedance-seed/seed-2.0-mini";

async function main() {
  const model = resolveModel(SLUG);
  console.log("model:", model.openRouterSlug, "| baseUrl:", model.baseUrl);

  // 1) plain completion
  const r1 = await complete(model, {
    messages: [{ role: "user", content: "Reply with exactly one word: pong", timestamp: Date.now() }],
  });
  console.log("\n[plain] stopReason:", r1.stopReason, "| error:", r1.errorMessage ?? "-");
  console.log("[plain] text:", JSON.stringify(r1.content.map((c) => c.text ?? c.type)), "| tokens:", r1.usage.totalTokens);

  // 2) tool-calling
  const tool = {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  };
  const r2 = await complete(model, {
    systemPrompt: "You have tools. When the user asks for weather, call get_weather.",
    messages: [{ role: "user", content: "What's the weather in Tokyo? Use your tool.", timestamp: Date.now() }],
    tools: [tool],
  });
  const calls = r2.content.filter((c) => c.type === "toolCall");
  console.log("\n[tools] stopReason:", r2.stopReason, "| error:", r2.errorMessage ?? "-");
  console.log("[tools] toolCalls:", JSON.stringify(calls.map((c) => ({ name: c.name, args: c.arguments }))));
  console.log("[tools] supportsToolCalling:", calls.length > 0 ? "YES ✅" : "NO ❌ (harness needs this)");
}

main().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(1); });
