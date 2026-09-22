import { describe, expect, it } from 'vitest';
import {
  daysRemaining, decideReminders, manualReminderKind, reminderOffsetDays, utcDay,
  type ReminderCandidate, type ReminderKind
} from './ittReminders.js';

/**
 * The due rule as a table, with no database. The scenario throughout is the one the
 * configuration screen describes: an ITT sent on 1 October with a four-week window, so the
 * return date is 29 October, the first reminder falls due on day 7 (8 October) and the second
 * on day 14 (15 October).
 */
const SETTINGS = { confirmInterestAtFraction: 0.25, submitTenderAtFraction: 0.5 };

const day = (iso: string) => new Date(`${iso}T00:30:00Z`);

function candidate(overrides: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    emailStatus: 'sent',
    sentAt: '2026-10-01T10:15:00Z',
    deadline: '2026-10-29',
    response: null,
    submitted: false,
    alreadySent: new Set<ReminderKind>(),
    ...overrides
  };
}

const forKind = (c: ReminderCandidate, kind: ReminderKind, asOf: string) =>
  decideReminders(c, SETTINGS, day(asOf)).find((d) => d.kind === kind)!;

describe('reminderOffsetDays', () => {
  it('takes a fraction of the window in whole days', () => {
    expect(reminderOffsetDays(28, 0.25)).toBe(7);
    expect(reminderOffsetDays(28, 0.5)).toBe(14);
  });

  it('is never the day of sending', () => {
    expect(reminderOffsetDays(5, 0.05)).toBe(1);
  });

  it('refuses a window too short for a reminder to fall inside it', () => {
    expect(reminderOffsetDays(1, 0.25)).toBeNull();
    expect(reminderOffsetDays(0, 0.25)).toBeNull();
    // 0.9 of 2 days rounds to the deadline itself, which is no use to anyone.
    expect(reminderOffsetDays(2, 0.9)).toBeNull();
  });
});

describe('confirm_interest', () => {
  it('is not due on day 6, is due on day 7', () => {
    expect(forKind(candidate(), 'confirm_interest', '2026-10-07')).toMatchObject({ due: false, reason: 'not_yet_due', dueOn: '2026-10-08' });
    expect(forKind(candidate(), 'confirm_interest', '2026-10-08')).toMatchObject({ due: true, reason: null });
  });

  it('is still due if the scheduler missed the day', () => {
    // The rule reads dates, not the tick, so a late or skipped run catches up.
    expect(forKind(candidate(), 'confirm_interest', '2026-10-12').due).toBe(true);
  });

  it.each([
    [null, true],
    ['no_response', true],
    // Neither an accept nor a decline: the whole point is a yes or a no.
    ['considering', true],
    ['will_tender', false],
    ['decline', false]
  ] as const)('response %s -> due %s', (response, due) => {
    expect(forKind(candidate({ response }), 'confirm_interest', '2026-10-10').due).toBe(due);
  });

  it('says why a firm that answered is not chased', () => {
    expect(forKind(candidate({ response: 'decline' }), 'confirm_interest', '2026-10-10').reason).toBe('already_responded');
  });

  it('is sent once', () => {
    const sent = candidate({ alreadySent: new Set<ReminderKind>(['confirm_interest']) });
    expect(forKind(sent, 'confirm_interest', '2026-10-10')).toMatchObject({ due: false, reason: 'already_sent' });
  });
});

describe('submit_tender', () => {
  const accepted = { response: 'will_tender' as const };

  it('is not due on day 13, is due on day 14', () => {
    expect(forKind(candidate(accepted), 'submit_tender', '2026-10-14').due).toBe(false);
    expect(forKind(candidate(accepted), 'submit_tender', '2026-10-15').due).toBe(true);
  });

  it('is never due for a firm that has not accepted', () => {
    expect(forKind(candidate({ response: null }), 'submit_tender', '2026-10-20').reason).toBe('not_accepted');
    expect(forKind(candidate({ response: 'considering' }), 'submit_tender', '2026-10-20').reason).toBe('not_accepted');
  });

  it('is never due for a firm that declined', () => {
    expect(forKind(candidate({ response: 'decline' }), 'submit_tender', '2026-10-20').reason).toBe('declined');
  });

  it('is not due once the tender is in', () => {
    expect(forKind(candidate({ ...accepted, submitted: true }), 'submit_tender', '2026-10-20').reason).toBe('already_submitted');
  });

  it('a firm that accepts late is chased as soon as the next run sees it', () => {
    // Accepted on day 20, when day 14 has long passed: still due, rather than never.
    expect(forKind(candidate(accepted), 'submit_tender', '2026-10-21').due).toBe(true);
  });
});

describe('things that stop every reminder', () => {
  it('nothing goes for an ITT that never went out', () => {
    for (const emailStatus of ['failed', 'skipped_no_email', null]) {
      const decisions = decideReminders(candidate({ emailStatus }), SETTINGS, day('2026-10-20'));
      expect(decisions.every((d) => !d.due && d.reason === 'not_sent')).toBe(true);
    }
  });

  it('nothing goes with no return date to count down to', () => {
    const decisions = decideReminders(candidate({ deadline: null, response: 'will_tender' }), SETTINGS, day('2026-10-20'));
    expect(decisions.every((d) => !d.due && d.reason === 'no_deadline')).toBe(true);
  });

  it('nothing goes on or after the return date', () => {
    for (const asOf of ['2026-10-29', '2026-11-05']) {
      const decisions = decideReminders(candidate({ response: 'will_tender' }), SETTINGS, day(asOf));
      expect(decisions.every((d) => !d.due && d.reason === 'past_deadline')).toBe(true);
    }
  });

  it('nothing goes for a one-day window', () => {
    const decisions = decideReminders(candidate({ deadline: '2026-10-02' }), SETTINGS, day('2026-10-02'));
    expect(decisions.every((d) => !d.due)).toBe(true);
  });
});

describe('the window follows the package, not a fixed number of days', () => {
  it('a five-day package is chased sooner than an eight-week one', () => {
    // Sent Thursday 1 Oct, a "5 working days" package returns Thursday 8 Oct: 7 calendar days.
    const short = forKind(candidate({ deadline: '2026-10-08' }), 'confirm_interest', '2026-10-03');
    expect(short.dueOn).toBe('2026-10-03');
    expect(short.due).toBe(true);
    // Eight weeks is 56 days, so a quarter is day 14.
    const long = forKind(candidate({ deadline: '2026-11-26' }), 'confirm_interest', '2026-10-15');
    expect(long.dueOn).toBe('2026-10-15');
    expect(long.due).toBe(true);
  });

  it('honours an organisation that has changed the fractions', () => {
    const settings = { confirmInterestAtFraction: 0.5, submitTenderAtFraction: 0.75 };
    const decisions = decideReminders(candidate(), settings, day('2026-10-15'));
    expect(decisions.find((d) => d.kind === 'confirm_interest')).toMatchObject({ due: true, dueOn: '2026-10-15' });
  });
});

describe('manualReminderKind', () => {
  it('sends confirm-interest until a firm has accepted, then submit-tender', () => {
    expect(manualReminderKind(null, false)).toEqual({ kind: 'confirm_interest' });
    expect(manualReminderKind('no_response', false)).toEqual({ kind: 'confirm_interest' });
    expect(manualReminderKind('considering', false)).toEqual({ kind: 'confirm_interest' });
    expect(manualReminderKind('will_tender', false)).toEqual({ kind: 'submit_tender' });
  });

  it('refuses a firm that declined or has submitted', () => {
    expect(manualReminderKind('decline', false)).toEqual({ kind: null, reason: 'declined' });
    expect(manualReminderKind('will_tender', true)).toEqual({ kind: null, reason: 'already_submitted' });
  });
});

describe('date helpers', () => {
  it('reads a DATE string and a timestamp to the same UTC day', () => {
    expect(utcDay('2026-10-01')).toBe(utcDay('2026-10-01T23:59:59Z'));
    expect(utcDay('2026-10-02')).toBe(utcDay('2026-10-01') + 1);
  });

  it('counts days remaining and never goes negative', () => {
    expect(daysRemaining('2026-10-29', day('2026-10-22'))).toBe(7);
    expect(daysRemaining('2026-10-29', day('2026-11-02'))).toBe(0);
  });
});
