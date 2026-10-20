/**
 * Mailbox-to-mailbox warmup: pure helpers.
 *
 * Warmup mailboxes trade short, natural business emails with each other so
 * mailbox providers see steady, engaged, two-way traffic on a new sender before
 * it starts cold outreach. This module holds the parts that need no I/O: the
 * daily ramp, pacing through the day, recipient choice, and the message copy.
 * The worker in the web app (lib/warmup.ts) does the sending and IMAP work.
 *
 * The compose functions take the spintax expander as an argument (pass
 * `expandSpintax` from `@workspace/core/spintax`), the same way
 * `resolveImapConfig` takes `decrypt`, so core modules don't import each other.
 *
 * Warmup copy deliberately carries no links, no opt-out footer and no custom
 * headers. Anything that makes it look like bulk mail defeats the purpose.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Ramp + pacing
// ---------------------------------------------------------------------------

export interface WarmupRamp {
  warmupStartVolume: number;
  warmupDailyIncrease: number;
  warmupMaxVolume: number;
  /** Start of the current ramp. Null is treated as "starts today". */
  warmupStartedAt: Date | null;
}

/**
 * Local calendar days since the ramp started (0 on the start date), counted
 * midnight to midnight in the server's timezone: the same boundary the worker
 * uses for "sent today", so the target steps up exactly when the count resets.
 */
export function warmupDaysSinceStart(ramp: WarmupRamp, now: Date): number {
  if (!ramp.warmupStartedAt) return 0;
  const start = ramp.warmupStartedAt;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Round, not floor: a DST change makes one local day 23 or 25 hours long.
  return Math.max(0, Math.round((today.getTime() - startDay.getTime()) / DAY_MS));
}

/**
 * How many new warmup emails this mailbox should send today:
 * `min(max, start + increase * daysSinceStart)`. Replies are not counted here.
 */
export function warmupDailyTarget(ramp: WarmupRamp, now: Date): number {
  const ramped = ramp.warmupStartVolume + ramp.warmupDailyIncrease * warmupDaysSinceStart(ramp, now);
  return Math.max(0, Math.min(ramp.warmupMaxVolume, ramped));
}

/**
 * Spread a day's sends evenly instead of bursting them all at once: the next
 * send is due once the share of the day that has passed "earns" it.
 *
 * @param sentToday             - new warmup emails this mailbox already sent today
 * @param target                - today's target from {@link warmupDailyTarget}
 * @param fractionOfDayElapsed  - 0..1, how far through the day we are
 */
export function isWarmupSendDue(
  sentToday: number,
  target: number,
  fractionOfDayElapsed: number,
): boolean {
  if (sentToday >= target) return false;
  return sentToday < target * fractionOfDayElapsed;
}

/** Roll against the mailbox's reply rate (0-100 percent). */
export function shouldWarmupReply(replyRatePercent: number): boolean {
  return Math.random() * 100 < replyRatePercent;
}

export interface WarmupPeer {
  id: number;
  /** When this sender last mailed this peer, or null if never. */
  lastMailedAt: Date | null;
}

/**
 * Pick the peer this sender has mailed least recently (never-mailed first),
 * breaking ties randomly. Never picks the sender itself. Returns null when
 * there is no other mailbox to send to.
 */
export function pickWarmupRecipient(senderId: number, peers: WarmupPeer[]): number | null {
  const others = peers.filter((p) => p.id !== senderId);
  if (others.length === 0) return null;

  const stamp = (p: WarmupPeer) => p.lastMailedAt?.getTime() ?? -Infinity;
  const oldest = Math.min(...others.map(stamp));
  const candidates = others.filter((p) => stamp(p) === oldest);
  return candidates[Math.floor(Math.random() * candidates.length)]!.id;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

interface WarmupTemplate {
  subject: string;
  body: string;
  /**
   * Choices the subject and body must agree on (the day, the topic). Each is
   * picked once and substituted wherever `[key]` appears in either; `[Key]`
   * gives the same pick with a capital first letter.
   */
  shared?: Record<string, string>;
}

const TEMPLATES: WarmupTemplate[] = [
  {
    subject: "{Quick question|Small question} about {next week|the schedule}",
    body: "Are you around {Tuesday|Wednesday|Thursday} {morning|afternoon} for a quick {call|catch-up}? {Nothing urgent|No rush}, I just want to line up {the next steps|a few details} before {the week gets busy|things pick up}.",
  },
  {
    subject: "{Notes|Follow-up} from {today|our call}",
    body: "{Thanks for the time earlier.|Good chatting earlier.} I {wrote up|put together} a few notes and will {share them|send them over} {tomorrow|later this week}. Let me know if I missed anything {important|on your side}.",
  },
  {
    subject: "{Updated|Revised} timeline",
    body: "{Small update|Quick heads-up}: the {draft|first version} is now looking like {end of the week|early next week}. {Does that still work for you?|Shout if that causes any trouble.}",
  },
  {
    subject: "[Meal] [when]?",
    body: "It has been a while. {Want to grab|Fancy} [meal] [when]? I am {pretty flexible|free most days} after {Monday|Tuesday}.",
    shared: { meal: "{coffee|lunch}", when: "{next week|sometime soon}" },
  },
  {
    subject: "{Thoughts on|About} [doc]",
    body: "I {had a look at|went through} [doc] {this morning|last night} and it {looks good|reads well} overall. {Two|A couple of} small {comments|questions}, but nothing that should hold things up.",
    shared: { doc: "{the proposal|the plan|the budget}" },
  },
  {
    subject: "{Checking in|Touching base}",
    body: "{Just checking in|Wanted to touch base} on {how things are going|where things landed}. {Anything I can help with on my end?|Happy to help if anything is stuck.}",
  },
  {
    subject: "[Meeting] moved to [day]",
    body: "{Heads-up|FYI}, I had to {move|shift} our [meeting] to [day] at the same time. {Hope that still works.|Let me know if that clashes with anything.}",
    shared: { meeting: "{meeting|call}", day: "{Thursday|Friday}" },
  },
  {
    subject: "{Thanks|Thank you} for the [intro]",
    body: "{Really appreciate|Thanks a lot for} the [intro]. We {have a call booked|are speaking} {next week|on Monday}, I will {let you know how it goes|keep you posted}.",
    shared: { intro: "{intro|referral}" },
  },
  {
    subject: "{Question|Quick one} on the [doc]",
    body: "{Could you|Would you mind} {confirming|double-checking} the {billing address|PO number} for the [doc] on your side? I want to make sure {everything matches|it goes through cleanly} {this month|this time}.",
    shared: { doc: "{invoice|order}" },
  },
  {
    subject: "{Agenda|Topics} for [meeting]",
    body: "{Here is what I have so far|Draft agenda below} for [meeting]: {status update, open questions, next steps|progress, blockers, and timing}. {Anything to add?|Feel free to add to it.}",
    shared: { meeting: "{Monday|our next sync}" },
  },
  {
    subject: "{Great|Nice} {seeing you|catching up} [when]",
    body: "{Really enjoyed the conversation|That was a good chat} [when]. {Let's keep in touch|Let's stay in touch} and {pick it up again|continue the conversation} {next month|soon}.",
    shared: { when: "{yesterday|last week}" },
  },
  {
    subject: "{Recap|Summary} and next steps",
    body: "{Quick recap|To sum up}: {we agreed on the scope|the scope is agreed} and {I will draft the first version|the first draft is on me}. {Expect something from me by Friday.|I will circle back by the end of the week.}",
  },
  {
    subject: "{Out|Away} [when]",
    body: "{Just a note|Small note} that I will be {out|offline} [when]. {Reach me by phone if anything comes up.|I will catch up on everything when I am back.}",
    shared: { when: "{on Friday|next Monday}" },
  },
  {
    subject: "{Feedback|Thoughts} on the [doc]",
    body: "{Thanks for sending the [doc] over.|Got the [doc], thanks.} {Overall it's in good shape|It's mostly there}; I {left a few comments|added a few notes} on the {second|last} section. {Happy to talk it through.|Easy fixes, I think.}",
    shared: { doc: "{draft|deck}" },
  },
  {
    subject: "{Are we still on|Still good} for [day]?",
    body: "{Just confirming|Quick confirm} we are still on for [day] at {10|11|2}. {I will send the dial-in shortly.|Same place as last time?}",
    shared: { day: "{tomorrow|Thursday}" },
  },
  {
    subject: "[Doc] {update|status}",
    body: "{Legal|Our team} {came back|replied} on the [doc] with {minor|a couple of small} edits. {Nothing major|Mostly wording}, so we should be able to {sign|wrap it up} {this week|soon}.",
    shared: { doc: "{contract|agreement}" },
  },
  {
    subject: "[Kind] [what]",
    body: "{Sharing|Passing along} our [kind] [what] for {the next few weeks|the coming month} so you can plan around it. {Let me know if you need anything before then.|Ping me if timing gets tight.}",
    shared: { kind: "{holiday|office}", what: "{schedule|hours}" },
  },
  {
    subject: "{Report|Numbers} for [period]",
    body: "{The report|The summary} for [period] is {ready|done}. {Numbers look steady|Things look stable overall}, with a {small|slight} uptick {at the end|in the last few weeks}.",
    shared: { period: "{last month|the quarter}" },
  },
  {
    subject: "{Quick favor|Small favor}",
    body: "{Could you|Would you be able to} {take a quick look at|review} {the outline I mentioned|the outline I shared last week} {when you get a minute|sometime this week}? {No rush at all.|Whenever suits you.}",
  },
  {
    subject: "{Welcome|Glad to have you} {aboard|on the project}",
    body: "{Great to have you on board.|Welcome to the project.} {I will set up|Let's find} {a short kickoff|some time} {this week|early next week} to {walk through the basics|get you up to speed}.",
  },
  {
    subject: "{Rescheduling|New time for} our [meeting]",
    body: "{Something came up|I have a conflict} {tomorrow|on Wednesday}. {Could we push|Can we move} our [meeting] {back a day|to later in the week}? {Sorry for the shuffle.|Apologies for the change.}",
    shared: { meeting: "{call|chat}" },
  },
  {
    subject: "{Ideas|Thoughts} for the [event]",
    body: "{Been thinking about|I had a few ideas for} the [event]. {Maybe a shorter morning session and more open time after lunch?|What if we kept it to half a day?} {Curious what you think.|Let me know your take.}",
    shared: { event: "{workshop|offsite}" },
  },
  {
    subject: "[Item] {confirmed|scheduled}",
    body: "{Good news|Quick update}: the [item] is {confirmed|booked} and should {arrive|land} by {Thursday|early next week}. {I will forward the tracking details.|Let me know once it is in.}",
    shared: { item: "{order|delivery}" },
  },
  {
    subject: "[Person] {update|question}",
    body: "{We spoke with|I met} the [person] you {suggested|mentioned} and {it went well|liked them a lot}. {Do you have time to compare notes?|Would love your view before we decide.}",
    shared: { person: "{candidate|applicant}" },
  },
  {
    subject: "{Following up|Circling back} on [ref]",
    body: "{Just circling back|Following up} on [ref]. {No pressure if you are swamped|I know things are busy}, {a short reply whenever you can is fine|just let me know when you get a chance}.",
    shared: { ref: "{my last note|the earlier email}" },
  },
];

const REPLY_TEMPLATES: string[] = [
  "{Thanks|Thank you}, {that works for me|sounds good}. {Talk soon.|Speak then.}",
  "{Got it|Noted}, {thanks for the heads-up|appreciate the update}.",
  "{Sounds good|Perfect}. {I will take a look|I will check} {later today|tomorrow} and {get back to you|follow up}.",
  "{Thanks for sending this|Thanks for the note}. {All clear on my side.|No questions from me.}",
  "{Yes|Sure}, {that time works|I can do that}. {See you then.|Looking forward to it.}",
  "{Appreciate it|Thanks a lot}. {I will let you know|I will keep you posted} {if anything changes|how it goes}.",
  "{Great|Nice}, {glad that's sorted|good to hear}. {Thanks again.|Have a good rest of the week.}",
  "{Thanks|Cheers} for {following up|checking in}. {All good here|Everything is on track} {for now|so far}.",
  "{Makes sense|Agreed}. {Let's go with that|Happy to go ahead} {and revisit next week|for now}.",
  "{Received|Got this}, thanks. {I will review it|I will go through it} {this afternoon|by tomorrow}.",
];

const GREETINGS = "{Hi|Hey|Hello}";
const SIGN_OFFS = "{Best|Cheers|All the best|Regards}";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** First word of a display name, or "" when there isn't one. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Spintax expander, e.g. `expandSpintax` from `@workspace/core/spintax`. */
export type SpintaxExpander = (text: string) => string;

function compose(expand: SpintaxExpander, fromName: string, toName: string, body: string): string {
  const to = firstName(toName);
  const from = firstName(fromName);
  const greeting = to ? `${expand(GREETINGS)} ${to},` : `${expand(GREETINGS)},`;
  const signOff = from ? `${expand(SIGN_OFFS)},\n${from}` : expand(SIGN_OFFS);
  return `${greeting}\n\n${body}\n\n${signOff}`;
}

export interface WarmupContent {
  subject: string;
  /** Plain text; callers convert newlines to <br> for the HTML part. */
  text: string;
}

/** A fresh warmup email: random template, spintax expanded, addressed by first name. */
export function composeWarmupEmail(
  expand: SpintaxExpander,
  opts: { fromName: string; toName: string },
): WarmupContent {
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)]!;
  const picks = Object.entries(template.shared ?? {}).map(([key, choices]) => [key, expand(choices)] as const);
  const fill = (text: string) =>
    picks.reduce(
      (out, [key, value]) =>
        out.replaceAll(`[${key}]`, value).replaceAll(`[${capitalize(key)}]`, capitalize(value)),
      text,
    );
  return {
    subject: expand(fill(template.subject)),
    text: compose(expand, opts.fromName, opts.toName, expand(fill(template.body))),
  };
}

/** A short reply to a received warmup email, threaded under its subject. */
export function composeWarmupReply(
  expand: SpintaxExpander,
  opts: { fromName: string; toName: string; subject: string },
): WarmupContent {
  const template = REPLY_TEMPLATES[Math.floor(Math.random() * REPLY_TEMPLATES.length)]!;
  const base = opts.subject.replace(/^\s*(re:\s*)+/i, "").trim();
  return {
    subject: `Re: ${base}`,
    text: compose(expand, opts.fromName, opts.toName, expand(template)),
  };
}
