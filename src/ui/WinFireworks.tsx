import { useEffect, useRef } from 'react'
import { Fireworks } from 'fireworks-js'

// Celebration layer for a won game. Fixed over the whole viewport so the
// show plays above the table and toolbar alike; the win dialog's overlay
// stacks above it (see .fireworks / .overlay z-indexes). The layer is
// pointer-transparent, so every control underneath keeps its click.
export function WinFireworks() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // A vestibular-safe win: skip the show, keep the dialog.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const fireworks = new Fireworks(host)
    fireworks.start()
    return () => {
      fireworks.stop(true)
    }
  }, [])

  return <div ref={hostRef} className="fireworks" />
}
