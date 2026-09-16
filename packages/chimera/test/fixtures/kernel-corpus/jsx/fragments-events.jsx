// Fragments (short syntax and React.Fragment) plus event-callback shapes:
// inline arrows, bound handlers passed as values, and object-literal config.
import React, { useState, useCallback } from 'react'
import { logEvent } from './telemetry'

const handlers = {
  onSubmit: logEvent,
  label: 'submit-form',
}

export function Wizard({ steps }) {
  const [active, setActive] = useState(0)
  const advance = useCallback(() => {
    logEvent('wizard-advance', { active })
    setActive(active + 1)
  }, [active])

  return (
    <>
      <header>
        <h1>Wizard</h1>
      </header>
      <React.Fragment key={steps[active].id}>
        <section onClick={advance}>{steps[active].body}</section>
        <footer>
          <button type="submit" onClick={() => handlers.onSubmit('wizard')}>
            Next
          </button>
          <button onClick={() => setActive(0)}>Reset</button>
        </footer>
      </React.Fragment>
    </>
  )
}
