import { createChimeraClient } from "@opencode-ai/sdk/v2/client"
import type {
  Event,
  FileContent,
  GlobalEvent,
  GlobalHealthResponse,
  PermissionRequest,
  Project,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionMessagesResponse,
  SessionStatus,
  SnapshotFileDiff,
} from "@opencode-ai/sdk/v2/client"

type ClientInput = {
  baseUrl?: string
  username?: string
  password?: string
}

type Result<T> = {
  data?: T
}

const DEFAULT_USERNAME = "chimera"

function auth(input: ClientInput) {
  if (!input.password) return
  return `Basic ${btoa(`${input.username || DEFAULT_USERNAME}:${input.password}`)}`
}

function unwrap<T>(result: Result<T>) {
  return result.data as T
}

function withDirectory(directory?: string) {
  if (!directory) return {}
  return { directory }
}

export function createNewWebClient(input: ClientInput = {}) {
  const authorization = auth(input)
  const client = createChimeraClient({
    baseUrl: input.baseUrl ?? window.location.origin,
    throwOnError: true,
    headers: authorization ? { Authorization: authorization } : undefined,
  })

  return {
    health: () => client.global.health().then(unwrap<GlobalHealthResponse>),
    listProjects: () => client.project.list().then(unwrap<Array<Project>>),
    getPath: (directory?: string) =>
      client.path.get(withDirectory(directory)).then(unwrap<{ directory: string; worktree: string; home: string }>),
    listSessions: (directory: string) =>
      client.session.list({ directory, roots: true, limit: 80 }).then(unwrap<Array<Session>>),
    getSession: (directory: string, sessionID: string) => client.session.get({ directory, sessionID }).then(unwrap<Session>),
    listMessages: (directory: string, sessionID: string, opts?: { limit?: number; before?: string }) =>
      client.session.messages({ directory, sessionID, limit: opts?.limit ?? 80, before: opts?.before }).then(unwrap<SessionMessagesResponse>),
    createSession: (directory: string, input?: { title?: string }) =>
      client.session.create({ directory, title: input?.title }).then(unwrap<Session>),
    sendPrompt: (directory: string, sessionID: string, text: string) =>
      client.session.promptAsync({ directory, sessionID, parts: [{ type: "text", text }] }).then(() => undefined),
    abortSession: (directory: string, sessionID: string) => client.session.abort({ directory, sessionID }).then(unwrap<boolean>),
    getSessionStatus: (directory: string) => client.session.status({ directory }).then(unwrap<Record<string, SessionStatus>>),
    listPermissions: (directory: string) => client.permission.list({ directory }).then(unwrap<Array<PermissionRequest>>),
    respondPermission: (directory: string, requestID: string, reply: "once" | "always" | "reject") =>
      client.permission.reply({ directory, requestID, reply }).then(unwrap<boolean>),
    listQuestions: (directory: string) => client.question.list({ directory }).then(unwrap<Array<QuestionRequest>>),
    replyQuestion: (directory: string, requestID: string, answers: Array<QuestionAnswer>) =>
      client.question.reply({ directory, requestID, answers }).then(unwrap<boolean>),
    rejectQuestion: (directory: string, requestID: string) =>
      client.question.reject({ directory, requestID }).then(unwrap<boolean>),
    getDiff: (directory: string, sessionID: string, messageID?: string) =>
      client.session.diff({ directory, sessionID, messageID }).then(unwrap<Array<SnapshotFileDiff>>),
    readFile: (directory: string, path: string) => client.file.read({ directory, path }).then(unwrap<FileContent>),
    subscribeGlobalEvents: async (input?: { signal?: AbortSignal }) =>
      client.global.event({ signal: input?.signal }).then((result) => result.stream as AsyncIterable<GlobalEvent | Event>),
  }
}

export type NewWebClient = ReturnType<typeof createNewWebClient>
