import { OpenAIResponsesLanguageModel } from "@/provider/sdk/copilot/responses/openai-responses-language-model"
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, SharedV3Warning } from "@ai-sdk/provider"

type GetArgsResult = { args: Record<string, unknown>; warnings: SharedV3Warning[] }

// getArgs is private; exercise it directly so the assertion targets the request
// body the model builds without coupling to the Responses response schema.
function getArgs(model: OpenAIResponsesLanguageModel, options: LanguageModelV3CallOptions) {
  return (model as unknown as { getArgs: (options: LanguageModelV3CallOptions) => Promise<GetArgsResult> }).getArgs(options)
}

function createModel(modelId = "test-model") {
  return new OpenAIResponsesLanguageModel(modelId, {
    provider: "copilot.responses",
    url: ({ path }) => `https://api.test.com${path}`,
    headers: () => ({ Authorization: "Bearer test-token" }),
  })
}

const PROMPT: LanguageModelV3CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

describe("OpenAIResponsesLanguageModel service tier", () => {
  // Regression for upstream ea2d59d7ca: an explicitly requested tier must reach
  // the request body even when the model id does not declare flex/priority
  // support. "test-model" matches no supported prefix, so the removed
  // validation blocks would previously have stripped it.
  test("preserves an explicit flex service tier for a model without declared support", async () => {
    const { args } = await getArgs(createModel(), {
      prompt: PROMPT,
      providerOptions: { copilot: { serviceTier: "flex" } },
    })
    expect(args.service_tier).toBe("flex")
  })

  test("preserves an explicit priority service tier for a model without declared support", async () => {
    const { args } = await getArgs(createModel(), {
      prompt: PROMPT,
      providerOptions: { copilot: { serviceTier: "priority" } },
    })
    expect(args.service_tier).toBe("priority")
  })
})