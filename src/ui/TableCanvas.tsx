import { useEffect, useRef } from 'react'
import { Application } from 'pixi.js'
import { createTableScene } from './scene.ts'
import type { SceneHandlers, TableScene } from './scene.ts'
import type { GameSnapshot } from '../store.ts'

interface TableCanvasProps {
  snapshot: GameSnapshot
  handlers: SceneHandlers
  // Lets the shell reach the scene imperatively (hint flashes).
  onSceneReady(scene: TableScene | null): void
  // A failed init (missing texture, no WebGL) must surface visibly; the
  // alternative is a silent blank table under a working toolbar.
  onSceneError(error: unknown): void
}

// Owns the one Pixi Application. StrictMode runs mount effects twice and
// Pixi v8's init() is async, so cleanup waits for its own init to settle
// before destroying, and the canvas only attaches if this mount is still
// live when init resolves. Pixi's resizeTo only listens for window
// resizes, so a ResizeObserver covers host-size changes the window never
// sees (the toolbar wrapping to a second row). Background color per
// DESIGN.md section 5.3.
export function TableCanvas({ snapshot, handlers, onSceneReady, onSceneError }: TableCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<TableScene | null>(null)
  const latestRef = useRef(snapshot)
  const callbacksRef = useRef({ handlers, onSceneReady, onSceneError })

  useEffect(() => {
    callbacksRef.current = { handlers, onSceneReady, onSceneError }
  }, [handlers, onSceneReady, onSceneError])

  useEffect(() => {
    latestRef.current = snapshot
    sceneRef.current?.update(snapshot)
  }, [snapshot])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const app = new Application()
    let live = true
    const observer = new ResizeObserver(() => app.resize())
    const forwarded: SceneHandlers = {
      onAction: (action) => callbacksRef.current.handlers.onAction(action),
      onTap: (spot) => callbacksRef.current.handlers.onTap(spot),
    }
    const ready = app
      .init({
        resizeTo: host,
        background: '#3A5D6F',
        antialias: true,
        // Render at device pixels or the card faces blur into mush on
        // high-DPI phones; capped because a 4x canvas costs real memory.
        resolution: Math.min(window.devicePixelRatio || 1, 3),
        autoDensity: true,
      })
      .then(async () => {
        if (!live) return
        host.appendChild(app.canvas)
        const scene = await createTableScene(app, forwarded)
        if (!live) {
          scene.destroy()
          return
        }
        sceneRef.current = scene
        scene.update(latestRef.current)
        observer.observe(host)
        callbacksRef.current.onSceneReady(scene)
      })
      .catch((error: unknown) => {
        if (live) callbacksRef.current.onSceneError(error)
      })
    return () => {
      live = false
      observer.disconnect()
      const scene = sceneRef.current
      sceneRef.current = null
      callbacksRef.current.onSceneReady(null)
      void ready.then(() => {
        scene?.destroy()
        try {
          app.destroy(true, { children: true })
        } catch {
          // A failed init can leave a partially-built Application; there
          // is nothing more to release.
        }
      })
    }
  }, [])

  return <div ref={hostRef} className="table-host" />
}
