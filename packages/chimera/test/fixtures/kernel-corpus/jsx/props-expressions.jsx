// Expression interpolation: braces, ternaries, template literals, list
// rendering via map, and spread props.
import React from 'react'
import { Row } from './row'
import { buildClassName } from './classnames'

const columns = ['name', 'score', 'rank']

export function Table({ rows, dense, onSelect }) {
  const tableClass = buildClassName('table', { dense })
  return (
    <table className={tableClass} data-dense={dense ? 'yes' : 'no'}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column}>{`col:${column}`}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <Row
            {...entry}
            key={entry.id}
            highlighted={entry.score > 10}
            onClick={() => onSelect(entry.id)}
          />
        ))}
      </tbody>
    </table>
  )
}

export function Status({ state }) {
  return <em>{state === 'loading' ? 'Working...' : state === 'done' ? 'Finished' : 'Idle'}</em>
}
