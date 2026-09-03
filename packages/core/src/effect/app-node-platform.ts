import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { HttpClient } from "effect/unstable/http"
import { FileSystem, Path } from "effect"
import { makeGlobalNode } from "./app-node"

export const filesystem = makeGlobalNode({ service: FileSystem.FileSystem, layer: NodeFileSystem.layer, deps: [] })
export const path = makeGlobalNode({ service: Path.Path, layer: NodePath.layer, deps: [] })
export const httpClient = makeGlobalNode({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
// Upstream also defines requestExecutor/llmClient nodes here; they require the
// @opencode-ai/llm package, which is not part of this workspace yet.

export * as LayerNodePlatform from "./app-node-platform"
