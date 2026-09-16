/**
 * Basic component shapes: function declaration, arrow component, class
 * component. Exercises component-ish extraction paths without TS types.
 */
import React from 'react'
import { formatTitle } from './format'

export function Panel(props) {
  const title = formatTitle(props.title)
  return (
    <div className="panel">
      <h2>{title}</h2>
      <main>{props.children}</main>
    </div>
  )
}

export const Badge = ({ label, tone = 'neutral' }) => {
  return <span className={'badge badge-' + tone}>{label}</span>
}

export class Counter extends React.Component {
  constructor(props) {
    super(props)
    this.state = { count: 0 }
    this.increment = this.increment.bind(this)
  }

  increment() {
    this.setState({ count: this.state.count + 1 })
  }

  render() {
    return (
      <button onClick={this.increment}>
        clicked {this.state.count} times
      </button>
    )
  }
}

export default Panel
