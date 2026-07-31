// Ultra is a Chimera product tier: selecting it changes the system prompt prefix
// (multi-agent mode block), which invalidates the session's prompt prefix cache.
// Confirm any switch that crosses the ultra boundary so users understand why
// cache hits drop temporarily.

export function shouldConfirmUltraSwitch(prev: string | undefined, next: string | undefined) {
  const isUltra = (value: string | undefined) => value?.toLowerCase() === "ultra"
  return isUltra(prev) !== isUltra(next)
}

export function ultraSwitchCopy(prev: string | undefined, next: string | undefined) {
  return next?.toLowerCase() === "ultra"
    ? {
        title: "Switch to ultra?",
        message:
          "Ultra changes the system prompt prefix (multi-agent mode); prompt cache hits will drop temporarily for this session.",
      }
    : {
        title: "Switch away from ultra?",
        message:
          "This restores the previous system prompt prefix; prompt cache hits will drop temporarily for this session.",
      }
}
