// Hook-driven state plus value-position identifiers: functions passed as
// props/references, shorthand object members, and effect callbacks calling
// module-scope helpers.
import React, { useEffect, useMemo, useRef } from 'react'
import { fetchProfile, cacheProfile } from './api'

function summarize(profile) {
  return `${profile.name} (${profile.role})`
}

export function ProfileCard({ userId, onSelect }) {
  const [profile, setProfile] = React.useState(null)
  const mounted = useRef(false)

  useEffect(() => {
    let cancelled = false
    fetchProfile(userId).then((fresh) => {
      if (!cancelled) {
        cacheProfile(fresh)
        setProfile(fresh)
      }
    })
    mounted.current = true
    return () => {
      cancelled = true
    }
  }, [userId])

  const summary = useMemo(() => (profile ? summarize(profile) : 'loading'), [profile])

  const actions = { summarize, onSelect }

  return (
    <article onClick={() => onSelect(userId)}>
      <h3>{summary}</h3>
      <details>{actions.summarize.name}</details>
    </article>
  )
}
