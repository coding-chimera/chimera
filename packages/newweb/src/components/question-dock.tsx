import { createSignal, For, Show } from "solid-js"
import type { QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2/client"

function defaultAnswers(questions: Array<QuestionInfo>) {
  return questions.map(() => [] as Array<string>)
}

export function QuestionDock(props: {
  items: Array<QuestionRequest>
  onReply: (requestID: string, answers: Array<Array<string>>) => void
  onReject: (requestID: string) => void
}) {
  const [answers, setAnswers] = createSignal<Record<string, Array<Array<string>>>>({})

  function toggle(request: QuestionRequest, questionIndex: number, label: string, multiple?: boolean) {
    const current = answers()[request.id] ?? defaultAnswers(request.questions)
    const selected = current[questionIndex] ?? []
    const next = multiple
      ? selected.includes(label)
        ? selected.filter((item) => item !== label)
        : [...selected, label]
      : [label]
    setAnswers({ ...answers(), [request.id]: current.map((item, index) => (index === questionIndex ? next : item)) })
  }

  return (
    <section class="dock">
      <div class="panel-title">Questions</div>
      <Show when={props.items.length === 0}>
        <div class="muted">No pending questions</div>
      </Show>
      <For each={props.items}>
        {(request) => (
          <article class="request-card">
            <small>session {request.sessionID}</small>
            <For each={request.questions}>
              {(question, index) => (
                <div class="question-block">
                  <strong>{question.header}</strong>
                  <p>{question.question}</p>
                  <div class="option-list">
                    <For each={question.options}>
                      {(option) => (
                        <button
                          type="button"
                          class={(answers()[request.id]?.[index()] ?? []).includes(option.label) ? "option active" : "option"}
                          onClick={() => toggle(request, index(), option.label, question.multiple)}
                        >
                          <span>{option.label}</span>
                          <small>{option.description}</small>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
            <div class="button-row">
              <button type="button" onClick={() => props.onReply(request.id, answers()[request.id] ?? defaultAnswers(request.questions))}>
                Reply
              </button>
              <button type="button" onClick={() => props.onReject(request.id)}>
                Reject
              </button>
            </div>
          </article>
        )}
      </For>
    </section>
  )
}
