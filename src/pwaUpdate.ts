// A solitaire tab can stay open for days, and the browser only checks for
// a new service worker on navigation — so poll hourly and whenever the tab
// comes back to the foreground (DESIGN.md section 6, vite-plugin-pwa's
// periodic-update recipe). Page-lifetime singleton: the register hook
// calls this once per load, so the interval and listener need no teardown.

const CHECK_INTERVAL_MS = 60 * 60 * 1000

export function scheduleSwUpdateChecks(registration: ServiceWorkerRegistration | undefined): void {
  if (registration === undefined) return
  const check = () => {
    // update() rejects while offline; a failed check is just "ask later".
    if (!navigator.onLine) return
    registration.update().catch(() => {})
  }
  setInterval(check, CHECK_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check()
  })
}
