import type { BrowserScenario } from "../../../src/browser/scenario"

export interface NewWebSmokeLabels {
  readonly newChat: string
  readonly settings: string
  readonly closeSettings: string
}

export function newWebSmoke(
  baseUrl: string,
  labels: NewWebSmokeLabels = {
    newChat: "New Chat",
    settings: "Settings",
    closeSettings: "Close settings",
  },
) {
  return {
    name: "NewWeb settings smoke",
    baseUrl,
    timeout: 45_000,
    browser: { headless: true, locale: "en-US" },
    steps: [
      { type: "open", url: "/" },
      {
        type: "wait",
        assertion: { type: "text", includes: labels.newChat },
        timeout: 15_000,
        interval: 100,
      },
      {
        type: "wait",
        assertion: { type: "interactable", target: { role: "button", name: labels.settings } },
        timeout: 15_000,
        interval: 100,
      },
      { type: "click", target: { role: "button", name: labels.settings } },
      {
        type: "wait",
        assertion: { type: "interactable", target: { role: "button", name: labels.settings, nth: 2 } },
        timeout: 10_000,
        interval: 100,
      },
      { type: "click", target: { role: "button", name: labels.settings, nth: 2 } },
      {
        type: "wait",
        assertion: { type: "interactable", target: { role: "button", name: labels.closeSettings } },
        timeout: 10_000,
        interval: 100,
      },
      { type: "click", target: { role: "button", name: labels.closeSettings } },
      {
        type: "wait",
        assertion: { type: "interactable", target: { role: "button", name: labels.settings } },
        timeout: 10_000,
        interval: 100,
      },
      { type: "screenshot", name: "newweb-settings-closed", fullPage: true },
      { type: "close" },
    ],
  } satisfies BrowserScenario.Scenario
}
