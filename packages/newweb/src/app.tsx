import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { MessageRow, NewWebState } from "@/state/store"
import { initialState } from "@/state/store"
import { applyNewWebEvent, eventDirectory, eventPayload } from "@/state/reducer"
import { createNewWebClient } from "@/api/client"
import { ServerGate } from "@/components/server-gate"
import { DirectoryPicker } from "@/components/directory-picker"
import { SessionList } from "@/components/session-list"
import { MessageTimeline } from "@/components/message-timeline"
import { Composer } from "@/components/composer"
import { PermissionDock } from "@/components/permission-dock"
import { QuestionDock } from "@/components/question-dock"
import { DiffPanel } from "@/components/diff-panel"
import { FilePreview } from "@/components/file-preview"

const client = createNewWebClient()

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function sortSessions(items: NewWebState["sessions"]["list"]) {
  return [...items].sort((a, b) => (b.time.updated || b.time.created) - (a.time.updated || a.time.created))
}

function mergeRows(existing: Array<MessageRow>, incoming: Array<MessageRow>, prepend: boolean) {
  const map = new Map<string, MessageRow>()
  for (const row of prepend ? [...incoming, ...existing] : [...existing, ...incoming]) map.set(row.info.id, row)
  return [...map.values()].sort((a, b) => a.info.time.created - b.info.time.created)
}

export function App() {
  const [state, setStore] = createStore(initialState())
  const activeRows = createMemo(() => (state.sessions.activeID ? (state.messages.bySessionID[state.sessions.activeID] ?? []) : []))
  const activeDiffs = createMemo(() => (state.sessions.activeID ? (state.preview.diffBySessionID[state.sessions.activeID] ?? []) : []))
  const canUseDirectory = createMemo(() => !!state.directory.current)
  const canUseSession = createMemo(() => !!state.directory.current && !!state.sessions.activeID)

  function loadHealth() {
    setStore("server", "loading", true)
    setStore("server", "error", undefined)
    return client
      .health()
      .then((health) => {
        setStore("server", {
          url: state.server.url,
          healthy: health.healthy,
          version: health.version,
          loading: false,
        })
      })
      .catch((error) => {
        setStore("server", "healthy", false)
        setStore("server", "loading", false)
        setStore("server", "error", messageOf(error))
      })
  }

  function loadProjects() {
    setStore("directory", "loading", true)
    return client
      .listProjects()
      .then((projects) => {
        setStore("directory", "projects", projects)
        setStore("directory", "loading", false)
      })
      .catch((error) => {
        setStore("directory", "loading", false)
        setStore("directory", "error", messageOf(error))
      })
  }

  function loadPath() {
    return client
      .getPath()
      .then((path) => selectDirectory(path.directory || path.worktree))
      .catch(() => undefined)
  }

  function loadSessions(directory = state.directory.current) {
    if (!directory) return Promise.resolve()
    setStore("sessions", "loading", true)
    setStore("sessions", "error", undefined)
    return Promise.all([client.listSessions(directory), client.getSessionStatus(directory)])
      .then(([sessions, status]) => {
        setStore("sessions", "list", sortSessions(sessions))
        setStore("sessions", "statusByID", status)
        setStore("sessions", "loading", false)
        if (!state.sessions.activeID && sessions[0]) selectSession(sessions[0].id, directory)
      })
      .catch((error) => {
        setStore("sessions", "loading", false)
        setStore("sessions", "error", messageOf(error))
      })
  }

  function loadRequests(directory = state.directory.current) {
    if (!directory) return Promise.resolve()
    setStore("requests", "loading", true)
    return Promise.all([client.listPermissions(directory), client.listQuestions(directory)])
      .then(([permissions, questions]) => {
        setStore("requests", "permissions", permissions)
        setStore("requests", "questions", questions)
        setStore("requests", "loading", false)
      })
      .catch((error) => {
        setStore("requests", "loading", false)
        setStore("requests", "error", messageOf(error))
      })
  }

  function loadMessages(sessionID = state.sessions.activeID, directory = state.directory.current, older = false) {
    if (!directory || !sessionID) return Promise.resolve()
    setStore("messages", "loadingBySessionID", sessionID, true)
    setStore("messages", "error", undefined)
    return client
      .listMessages(directory, sessionID, {
        before: older ? state.messages.cursorBySessionID[sessionID] : undefined,
        limit: 80,
      })
      .then((rows) => {
        setStore("messages", "bySessionID", sessionID, (existing = []) => mergeRows(existing, rows, older))
        setStore("messages", "cursorBySessionID", sessionID, rows[0]?.info.id)
        setStore("messages", "loadingBySessionID", sessionID, false)
      })
      .catch((error) => {
        setStore("messages", "loadingBySessionID", sessionID, false)
        setStore("messages", "error", messageOf(error))
      })
  }

  function selectDirectory(directory: string) {
    const next = directory.trim()
    if (!next) return
    setStore("directory", "current", next)
    setStore("directory", "input", next)
    setStore("sessions", "activeID", undefined)
    setStore("sessions", "list", [])
    setStore("messages", "bySessionID", {})
    void loadSessions(next).then(() => loadRequests(next))
  }

  function selectSession(sessionID: string, directory = state.directory.current) {
    setStore("sessions", "activeID", sessionID)
    void loadMessages(sessionID, directory)
    void loadRequests(directory)
  }

  function createSession() {
    if (!state.directory.current) return
    setStore("sessions", "creating", true)
    void client
      .createSession(state.directory.current, { title: "New session" })
      .then((session) => {
        setStore("sessions", "list", (items) => sortSessions([session, ...items]))
        selectSession(session.id)
      })
      .catch((error) => setStore("sessions", "error", messageOf(error)))
      .finally(() => setStore("sessions", "creating", false))
  }

  function sendPrompt() {
    if (!state.directory.current || !state.composer.text.trim()) return
    setStore("composer", "sending", true)
    setStore("composer", "error", undefined)
    const text = state.composer.text.trim()
    const session = state.sessions.activeID
      ? Promise.resolve({ id: state.sessions.activeID })
      : client.createSession(state.directory.current, { title: text.slice(0, 80) })
    void session
      .then((target) => {
        setStore("sessions", "activeID", target.id)
        return client.sendPrompt(state.directory.current, target.id, text).then(() => target.id)
      })
      .then((sessionID) => {
        setStore("composer", "text", "")
        void loadMessages(sessionID)
        window.setTimeout(() => {
          void loadMessages(sessionID)
          void loadSessions()
          void loadRequests()
        }, 1200)
      })
      .catch((error) => setStore("composer", "error", messageOf(error)))
      .finally(() => setStore("composer", "sending", false))
  }

  function abortSession() {
    if (!state.directory.current || !state.sessions.activeID) return
    void client.abortSession(state.directory.current, state.sessions.activeID).then(() => loadSessions())
  }

  function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    if (!state.directory.current) return
    setStore("requests", "permissions", (items) => items.filter((item) => item.id !== requestID))
    void client.respondPermission(state.directory.current, requestID, reply).catch((error) => {
      setStore("requests", "error", messageOf(error))
      void loadRequests()
    })
  }

  function replyQuestion(requestID: string, answers: Array<Array<string>>) {
    if (!state.directory.current) return
    setStore("requests", "questions", (items) => items.filter((item) => item.id !== requestID))
    void client.replyQuestion(state.directory.current, requestID, answers).catch((error) => {
      setStore("requests", "error", messageOf(error))
      void loadRequests()
    })
  }

  function rejectQuestion(requestID: string) {
    if (!state.directory.current) return
    setStore("requests", "questions", (items) => items.filter((item) => item.id !== requestID))
    void client.rejectQuestion(state.directory.current, requestID).catch((error) => {
      setStore("requests", "error", messageOf(error))
      void loadRequests()
    })
  }

  function loadDiff(messageID?: string) {
    if (!state.directory.current || !state.sessions.activeID) return
    const sessionID = state.sessions.activeID
    setStore("preview", "diffLoading", true)
    void client
      .getDiff(state.directory.current, sessionID, messageID)
      .then((diff) => setStore("preview", "diffBySessionID", sessionID, diff))
      .catch((error) => setStore("preview", "error", messageOf(error)))
      .finally(() => setStore("preview", "diffLoading", false))
  }

  function openFile(path: string) {
    if (!state.directory.current) return
    setStore("preview", "openFile", path)
    setStore("preview", "fileLoading", true)
    setStore("preview", "error", undefined)
    void client
      .readFile(state.directory.current, path)
      .then((content) => setStore("preview", "fileContent", content))
      .catch((error) => setStore("preview", "error", messageOf(error)))
      .finally(() => setStore("preview", "fileLoading", false))
  }

  function reloadFile() {
    if (state.preview.openFile) openFile(state.preview.openFile)
  }

  function refreshAll() {
    void loadHealth()
    void loadProjects()
    void loadSessions()
    void loadRequests()
    if (state.sessions.activeID) void loadMessages()
  }

  onMount(() => {
    void loadHealth()
    void loadProjects()
    void loadPath()
    const abort = new AbortController()
    void client
      .subscribeGlobalEvents({ signal: abort.signal })
      .then(async (events) => {
        for await (const event of events) {
          const payload = eventPayload(event)
          if (!payload) continue
          if (eventDirectory(event, state.directory.current) !== state.directory.current) continue
          applyNewWebEvent(setStore, state.directory.current, payload)
        }
      })
      .catch((error) => {
        if (abort.signal.aborted) return
        setStore("server", "error", messageOf(error))
      })
    onCleanup(() => abort.abort())
  })

  return (
    <main class="newweb-shell">
      <aside class="sidebar">
        <ServerGate server={state.server} onRefresh={loadHealth} />
        <DirectoryPicker
          current={state.directory.current}
          input={state.directory.input}
          projects={state.directory.projects}
          loading={state.directory.loading}
          error={state.directory.error}
          onInput={(value) => setStore("directory", "input", value)}
          onSelect={selectDirectory}
          onSubmit={() => selectDirectory(state.directory.input)}
          onRefresh={loadProjects}
        />
        <SessionList
          sessions={state.sessions.list}
          activeID={state.sessions.activeID}
          statusByID={state.sessions.statusByID}
          loading={state.sessions.loading}
          creating={state.sessions.creating}
          error={state.sessions.error}
          onSelect={selectSession}
          onCreate={createSession}
          onRefresh={() => void loadSessions()}
        />
      </aside>
      <section class="main-column">
        <Show when={canUseDirectory()} fallback={<div class="empty-state">Choose a directory to start.</div>}>
          <MessageTimeline
            rows={activeRows()}
            loading={!!(state.sessions.activeID && state.messages.loadingBySessionID[state.sessions.activeID])}
            error={state.messages.error}
            onLoadOlder={() => void loadMessages(state.sessions.activeID, state.directory.current, true)}
            onOpenFile={openFile}
            onOpenDiff={loadDiff}
          />
          <div class="request-grid">
            <PermissionDock items={state.requests.permissions} onRespond={respondPermission} />
            <QuestionDock items={state.requests.questions} onReply={replyQuestion} onReject={rejectQuestion} />
          </div>
          <Composer
            text={state.composer.text}
            sending={state.composer.sending}
            canSend={canUseDirectory()}
            error={state.composer.error}
            onInput={(value) => setStore("composer", "text", value)}
            onSend={sendPrompt}
            onAbort={abortSession}
          />
        </Show>
      </section>
      <aside class="preview-column">
        <DiffPanel diffs={activeDiffs()} loading={state.preview.diffLoading} onRefresh={() => loadDiff()} onOpenFile={openFile} />
        <FilePreview
          path={state.preview.openFile}
          content={state.preview.fileContent}
          loading={state.preview.fileLoading}
          error={state.preview.error}
          onReload={reloadFile}
          onClose={() => {
            setStore("preview", "openFile", undefined)
            setStore("preview", "fileContent", undefined)
          }}
        />
      </aside>
      <button type="button" class="refresh-fab" onClick={refreshAll} disabled={!canUseDirectory()}>
        Refresh all
      </button>
      <Show when={!canUseSession() && canUseDirectory()}>
        <div class="floating-note">Create or select a session, then send a prompt.</div>
      </Show>
    </main>
  )
}
