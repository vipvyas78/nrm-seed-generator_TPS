/**
 * When a subcontractor is due a reminder, and which one.
 *
 * Pure: no database and no clock of its own - `asOf` is a parameter. That is what lets the
 * whole rule be tested as a table, and what lets a simulated timeline (TEST_EMAIL_FLAG) run
 * without waiting four weeks. It also means the rule cannot depend on WHEN the scheduler fires:
 * a cron a few minutes late, or a whole day missed, gives the same answer on the next run.
 *
 * THE WINDOW. Start is the day the ITT actually went out (itt_dispatch.email_sent_at); end is
 * the return deadline in force for that package (the workflow's explicit date, else the date
 * stamped at first dispatch - the precedence tenderPrepDb.resolveReturnDeadline states). A
 * reminder is due once `fraction` of that window has elapsed, so a 4-week package and a 5-day
 * package both work without anyone converting fractions to days.
 *
 * WHOLE UTC DAYS, deliberately. The deadline is a DATE and the scheduler fires once a day, so
 * anything finer would be false precision - and it keeps "a 4-week window sends the first
 * reminder on day 7" literally true, which is what the configuration screen tells people.
 *
 * NO DEADLINE, NO REMINDER. A chase counting down to a date nobody holds is worse than no
 * chase, so the clause is skipped and REPORTED rather than guessed - the same refusal
 * `build_type_index` makes without a storey height.
 */

export type ReminderKind = 'confirm_interest' | 'submit_tender';

export type IttResponse = 'will_tender' | 'decline' | 'considering' | 'no_response' | null;

export interface ReminderCandidate {
  /** 'sent' only: chasing a firm about an invitation that never went out would paper over a
   *  real omission, and it would print a window that never opened. */
  emailStatus: string | null;
  /** When the ITT actually went out. */
  sentAt: Date | string | null;
  /** 'YYYY-MM-DD' - the return date in force, or null when nobody has one. */
  deadline: string | null;
  response: IttResponse;
  /** The firm has submitted: a portal submission or a tender return on file. */
  submitted: boolean;
  /** Automatic reminders already sent for this entry. */
  alreadySent: ReadonlySet<ReminderKind>;
}

export interface ReminderSettings {
  /** 0 < x < 1, fractions of the tender window. */
  confirmInterestAtFraction: number;
  submitTenderAtFraction: number;
}

export type SkipReason =
  | 'not_sent'            // the ITT never went out
  | 'no_deadline'         // nothing to count down to
  | 'window_too_short'    // a reminder cannot fall strictly between send and deadline
  | 'past_deadline'       // there is nothing left to confirm or submit
  | 'already_responded'   // confirm_interest: they said yes or no
  | 'not_accepted'        // submit_tender: they have not said yes
  | 'declined'            // submit_tender: they said no
  | 'already_submitted'   // submit_tender: it is in
  | 'already_sent'        // this automatic reminder has gone
  | 'not_yet_due';

export interface ReminderDecision {
  kind: ReminderKind;
  due: boolean;
  reason: SkipReason | null;
  /** 'YYYY-MM-DD' the reminder falls due on, when the window is well formed. */
  dueOn: string | null;
}

const MS_PER_DAY = 86_400_000;

/** Whole days since the epoch, in UTC, from a Date or a 'YYYY-MM-DD' / ISO string. */
export function utcDay(value: Date | string): number {
  const date = typeof value === 'string'
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
    : value;
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY);
}

const dayToIso = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

/**
 * Days after sending on which a fraction of the window has elapsed.
 *
 * At least one day: a reminder on the day of sending is not a reminder. Null when that would
 * land on or after the deadline itself - a chase on the return date is no use to anyone.
 */
export function reminderOffsetDays(totalDays: number, fraction: number): number | null {
  if (totalDays < 2) return null;
  const offset = Math.max(1, Math.round(fraction * totalDays));
  return offset < totalDays ? offset : null;
}

function decide(
  kind: ReminderKind, c: ReminderCandidate, fraction: number, asOf: Date
): ReminderDecision {
  const skip = (reason: SkipReason, dueOn: string | null = null): ReminderDecision =>
    ({ kind, due: false, reason, dueOn });

  if (c.emailStatus !== 'sent' || !c.sentAt) return skip('not_sent');
  if (!c.deadline) return skip('no_deadline');

  const start = utcDay(c.sentAt);
  const end = utcDay(c.deadline);
  const offset = reminderOffsetDays(end - start, fraction);
  if (offset === null) return skip('window_too_short');

  const dueDay = start + offset;
  const dueOn = dayToIso(dueDay);
  const today = utcDay(asOf);

  // Strictly before the deadline. A run that only happens on the return date itself (the
  // scheduler was down) sends nothing: the chase is no longer useful and could confuse.
  if (today >= end) return skip('past_deadline', dueOn);

  if (kind === 'confirm_interest') {
    // 'considering' and 'no_response' are NOT answers - the point is a yes or a no.
    if (c.response === 'will_tender' || c.response === 'decline') return skip('already_responded', dueOn);
  } else {
    if (c.response === 'decline') return skip('declined', dueOn);
    if (c.response !== 'will_tender') return skip('not_accepted', dueOn);
    if (c.submitted) return skip('already_submitted', dueOn);
  }

  if (c.alreadySent.has(kind)) return skip('already_sent', dueOn);
  if (today < dueDay) return skip('not_yet_due', dueOn);
  return { kind, due: true, reason: null, dueOn };
}

/**
 * Both reminders' verdicts for one firm and package, due or not and why.
 *
 * Returning the skip reasons rather than only what is due is what makes the scheduled run's
 * summary useful: "3 skipped: no return date" is an instruction to somebody, where silence
 * reads as "nothing to do".
 */
export function decideReminders(
  candidate: ReminderCandidate, settings: ReminderSettings, asOf: Date
): ReminderDecision[] {
  return [
    decide('confirm_interest', candidate, settings.confirmInterestAtFraction, asOf),
    decide('submit_tender', candidate, settings.submitTenderAtFraction, asOf)
  ];
}

/**
 * Which email an estimator's manual "Send reminder" should send, decided by the SERVER so
 * that "the correct email" is a property of the firm's state and not of which button
 * somebody clicked.
 *
 * Null with a reason when neither applies. A declined firm must not be chased, and a firm
 * that has submitted must not be told to.
 */
export function manualReminderKind(
  response: IttResponse, submitted: boolean
): { kind: ReminderKind } | { kind: null; reason: 'declined' | 'already_submitted' } {
  if (response === 'decline') return { kind: null, reason: 'declined' };
  if (submitted) return { kind: null, reason: 'already_submitted' };
  return { kind: response === 'will_tender' ? 'submit_tender' : 'confirm_interest' };
}

/** Whole days from `asOf` to the deadline, never negative. Feeds the {{daysRemaining}} token. */
export function daysRemaining(deadline: string, asOf: Date): number {
  return Math.max(0, utcDay(deadline) - utcDay(asOf));
}
