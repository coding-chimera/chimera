import type {
  FileContent,
  GlobalHealthResponse,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionMessagesResponse,
  SessionStatus,
  SnapshotFileDiff,
} from "@opencode-ai/sdk/v2/client"

export type MessageRow = SessionMessagesResponse[number]

export type NewWebState = {
  server: {
    url: string
    healthy: boolean
    version?: string
    loading: boolean
    error?: string
  }
  directory: {
    current: string
    input: string
    projects: Array<Project>
    loading: boolean
    error?: string
  }
  sessions: {
    list: Array<Session>
    activeID?: string
    statusByID: Record<string, SessionStatus>
    loading: boolean
    creating: boolean
    error?: string
  }
  messages: {
    bySessionID: Record<string, Array<MessageRow>>
    loadingBySessionID: Record<string, boolean>
    cursorBySessionID: Record<string, string | undefined>
    error?: string
  }
  requests: {
    permissions: Array<PermissionRequest>
    questions: Array<QuestionRequest>
    loading: boolean
    error?: string
  }
  preview: {
    diffBySessionID: Record<string, Array<SnapshotFileDiff>>
    diffLoading: boolean
    openFile?: string
    fileContent?: FileContent
    fileLoading: boolean
    error?: string
  }
  composer: {
    text: string
    sending: boolean
    error?: string
  }
}

export function initialState(): NewWebState {
  return {
    server: {
      url: window.location.origin,
      healthy: false,
      loading: true,
    },
    directory: {
      current: "",
      input: "",
      projects: [],
      loading: false,
    },
    sessions: {
      list: [],
      statusByID: {},
      loading: false,
      creating: false,
    },
    messages: {
      bySessionID: {},
      loadingBySessionID: {},
      cursorBySessionID: {},
    },
    requests: {
      permissions: [],
      questions: [],
      loading: false,
    },
    preview: {
      diffBySessionID: {},
      diffLoading: false,
      fileLoading: false,
    },
    composer: {
      text: "",
      sending: false,
    },
  }
}

export type Health = GlobalHealthResponse
