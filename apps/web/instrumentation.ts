/**
 * Lightreach in-process scheduler
 *
 * Next.js calls `register()` once when the Node.js server boots.
 * We use it to start the background send-loop tick.
 *
 * ⚠️  SERVERLESS NOTE: This only works correctly in a persistent Node.js
 * process (`pnpm start`). On serverless platforms (Vercel, Netlify…) the
 * process may be spun down between requests, causing the scheduler to miss
 * ticks. For production serverless use, replace this with an external cron
 * job that calls a Route Handler endpoint.
 */

export async function register() {
  // Only run on the Node.js runtime, never on Edge
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  // Lazy-import to keep the Edge bundle clean
  const { startScheduler } = await import("./lib/scheduler")
  startScheduler()

  const { startInboxPoller } = await import("./lib/inbox-poller")
  startInboxPoller()

  const { startHealthMonitor } = await import("./lib/health")
  startHealthMonitor()
}
