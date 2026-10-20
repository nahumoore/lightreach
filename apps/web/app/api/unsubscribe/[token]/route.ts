import { db, leads, messages } from '@workspace/db'
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { suppress, verifyUnsubscribeToken } from '@/lib/suppression'

// Node.js runtime: decrypting the token needs `crypto`, and the DB is better-sqlite3.
export const runtime = 'nodejs'
// Never cache; every request is a live token check.
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> }

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Self-contained page: no /_next assets, no scripts, no hard-coded colors.
 * `color-scheme: light dark` lets the browser pick the system palette.
 */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0; padding: 4rem 1.5rem; }
  main { max-width: 28rem; margin: 0 auto; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.25rem; opacity: 0.75; }
  button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 0.375rem; cursor: pointer; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

function invalidLink(): Response {
  return page(
    'Link not valid',
    `<h1>This link is not valid</h1>
<p>It may be incomplete or no longer active. If you still want to stop receiving these emails, reply to one with "STOP".</p>`,
    404,
  )
}

/**
 * Confirmation page. GET never changes anything: mail scanners and link
 * previews open every URL in an email, so the opt-out only happens on POST.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { token } = await params
  const payload = verifyUnsubscribeToken(token)
  if (!payload) return invalidLink()

  return page(
    'Unsubscribe',
    `<h1>Unsubscribe</h1>
<p>Stop receiving emails at <strong>${escapeHtml(payload.email)}</strong>?</p>
<form method="post">
<button type="submit">Unsubscribe</button>
</form>`,
  )
}

/**
 * Performs the opt-out. Also the target of the one-click request that mail
 * clients send for `List-Unsubscribe-Post` (the body is not needed). Idempotent.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const { token } = await params
  const payload = verifyUnsubscribeToken(token)
  if (!payload) return invalidLink()

  // The message row is gone if its campaign was deleted; the token still carries the address.
  const [message] = await db
    .select({ id: messages.id, leadId: messages.leadId })
    .from(messages)
    .where(eq(messages.id, payload.messageRowId))

  await suppress({
    kind: 'email',
    value: payload.email,
    reason: 'unsubscribed',
    leadId: message?.leadId,
    messageId: message?.id,
  })

  // The lead this email was sent to, plus the same address in any other list.
  const sameAddress = await db
    .select({ id: leads.id })
    .from(leads)
    .where(sql`lower(${leads.email}) = ${payload.email}`)
  const leadIds = [...new Set([...sameAddress.map((l) => l.id), ...(message ? [message.leadId] : [])])]

  if (leadIds.length > 0) {
    // Same rule as the inbox poller: a bounced or already unsubscribed lead keeps its status.
    await db
      .update(leads)
      .set({ status: 'unsubscribed' })
      .where(and(inArray(leads.id, leadIds), notInArray(leads.status, ['bounced', 'unsubscribed'])))
    await db
      .update(messages)
      .set({ status: 'skipped' })
      .where(and(inArray(messages.leadId, leadIds), eq(messages.status, 'queued')))
  }

  return page(
    'Unsubscribed',
    `<h1>You have been unsubscribed</h1>
<p><strong>${escapeHtml(payload.email)}</strong> will not receive any more emails from us.</p>`,
  )
}
