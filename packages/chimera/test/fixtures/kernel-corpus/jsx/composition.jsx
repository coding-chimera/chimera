// Component composition: children prop, wrapper components, higher-order
// component call at module scope, and a rendered list of composed elements.
import React from 'react'
import { Panel } from './component-basics'
import { withTheme } from './theme'

function Toolbar({ items, onPick }) {
  return (
    <nav>
      {items.map((item) => (
        <button key={item.id} onClick={() => onPick(item)}>
          {item.label}
        </button>
      ))}
    </nav>
  )
}

const ThemedToolbar = withTheme(Toolbar)

export function Screen({ items, theme }) {
  const pick = (item) => {
    console.log('picked', item.id)
  }
  return (
    <Panel title="Screen">
      <ThemedToolbar items={items} onPick={pick} theme={theme} />
      <aside>
        <Toolbar items={items} onPick={pick} />
      </aside>
    </Panel>
  )
}
