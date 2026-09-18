/**
 * How long a package is tendered for, and what date that resolves to.
 *
 * Pure: no database, no clock of its own. It exists so the limits live in ONE place that the
 * request schema (app.ts), the persistence layer (tenderPrepDb.ts) and a fast unit test all
 * import, sitting beside the CHECK constraint in migration 021 that says the same thing.
 */

/** A tuple, not an array, so z.enum can take it directly in app.ts. */
export const TENDER_RETURN_UNITS = ['days', 'weeks'] as const;

export type TenderReturnUnit = (typeof TENDER_RETURN_UNITS)[number];

/** 1-5 days or 1-8 weeks. Mirrors shortlists_tender_return_period_check (migration 021). */
export const TENDER_RETURN_MAX: Record<TenderReturnUnit, number> = { days: 5, weeks: 8 };

export function isTenderReturnUnit(value: unknown): value is TenderReturnUnit {
  return value === 'days' || value === 'weeks';
}

export function isValidTenderReturnPeriod(value: number, unit: TenderReturnUnit): boolean {
  return Number.isInteger(value) && value >= 1 && value <= TENDER_RETURN_MAX[unit];
}

/**
 * The return date a period resolves to, counted from the day the ITT goes out.
 *
 * WORKING days, calendar weeks. "5 days" is a working week — the reading a construction ITT
 * takes, and the one that keeps 5 days consistent with 1 week; five CALENDAR days issued on a
 * Thursday would hand a tenderer three working days to price. Weeks are calendar weeks, so a
 * Thursday send returns on a Thursday.
 *
 * Bank holidays are deliberately not modelled. There is no holiday calendar anywhere in this
 * codebase, and a wrong one is worse than none: a date that quietly differs from the letter a
 * tenderer holds is the failure this whole column exists to avoid.
 *
 * Returns 'YYYY-MM-DD', never a Date. The value goes straight into a DATE column and is
 * formatted for display from its own parts, so no timezone round-trip is ever possible — the
 * BFF sets no pg type parser, and a DATE read back as a local-midnight Date serialises to the
 * PREVIOUS day under a positive UTC offset.
 *
 * The arithmetic is on UTC date parts rather than millisecond addition, so a DST boundary
 * cannot shift the answer by a day.
 */
export function deriveReturnDate(from: Date, value: number, unit: TenderReturnUnit): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();

  if (unit === 'weeks') {
    return iso(new Date(Date.UTC(y, m, d + value * 7)));
  }

  // One working day at a time. Stepping is the only way to skip weekends correctly for a
  // range this small, and at a maximum of five steps there is nothing to optimise.
  let remaining = value;
  let cursor = new Date(Date.UTC(y, m, d));
  while (remaining > 0) {
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1));
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return iso(cursor);
}

const iso = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
