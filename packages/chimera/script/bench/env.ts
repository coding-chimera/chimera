// IMPORTANT: this module must be the FIRST import of the bench entry. It
// mirrors test/preload.ts: xdg-basedir and several Global paths read these
// env vars at import time, so they have to be set before any src/ module is
// evaluated. Everything here is synchronous so ESM import ordering guarantees
// the vars are in place before the next imports run.
import fs from "fs"
import os from "os"
import path from "path"

const dir = path.join(os.tmpdir(), `opencode-bench-data-${process.pid}`)
fs.mkdirSync(path.join(dir, "home"), { recursive: true })
fs.mkdirSync(path.join(dir, "cache", "chimera"), { recursive: true })
// Write the cache version file to prevent global/index.ts from clearing the cache
fs.writeFileSync(path.join(dir, "cache", "chimera", "version"), "14")

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_MODELS_PATH"] = path.resolve(import.meta.dir, "../../test/tool/fixtures/models-api.json")
process.env["OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = path.join(dir, "managed")
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"

// Clear provider and server auth env vars to ensure clean bench state
for (const key of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENROUTER_API_KEY",
  "LLM_GATEWAY_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
]) {
  delete process.env[key]
}

// In-memory sqlite, matching the test environment
process.env["OPENCODE_DB"] = ":memory:"

process.on("exit", () => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

export * as BenchEnv from "./env"
