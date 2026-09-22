import { describe, expect, it } from 'vitest';
import { deriveReturnDate, isValidTenderReturnPeriod, TENDER_RETURN_MAX } from '../../src/tenderReturnPeriod.js';

// Every fixture is built at UTC midnight, the same way tenderPrepDb normalises `asOf`.
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('deriveReturnDate — weeks', () => {
  it('adds calendar weeks, landing on the same weekday', () => {
    // 2026-09-17 is a Thursday.
    expect(deriveReturnDate(utc('2026-09-17'), 1, 'weeks')).toBe('2026-09-24');
    expect(deriveReturnDate(utc('2026-09-17'), 3, 'weeks')).toBe('2026-10-08');
    expect(deriveReturnDate(utc('2026-09-17'), 8, 'weeks')).toBe('2026-11-12');
  });

  it('crosses a year boundary', () => {
    expect(deriveReturnDate(utc('2026-12-30'), 1, 'weeks')).toBe('2027-01-06');
  });
});

describe('deriveReturnDate — working days', () => {
  it('skips the weekend, so five days is a working week', () => {
    // Thursday + 5 working days is the following Thursday — the same answer as 1 week,
    // which is the whole reason "days" means working days here.
    expect(deriveReturnDate(utc('2026-09-17'), 5, 'days')).toBe('2026-09-24');
    expect(deriveReturnDate(utc('2026-09-17'), 1, 'days')).toBe('2026-09-18'); // Fri
    expect(deriveReturnDate(utc('2026-09-17'), 2, 'days')).toBe('2026-09-21'); // Mon
  });

  it('counts from a Friday into the next week', () => {
    // 2026-09-18 is a Friday: +1 is Monday, not Saturday.
    expect(deriveReturnDate(utc('2026-09-18'), 1, 'days')).toBe('2026-09-21');
    expect(deriveReturnDate(utc('2026-09-18'), 5, 'days')).toBe('2026-09-25');
  });

  it('counts from a Saturday without ever landing on one', () => {
    // 2026-09-19 is a Saturday. The first working day after it is Monday.
    expect(deriveReturnDate(utc('2026-09-19'), 1, 'days')).toBe('2026-09-21');
  });

  it('crosses a month and a year boundary', () => {
    expect(deriveReturnDate(utc('2026-12-30'), 5, 'days')).toBe('2027-01-06');
  });

  it('is calendar arithmetic, not millisecond addition, across a DST boundary', () => {
    // UK clocks go forward on 2026-03-29. A `+ n * 86_400_000` implementation reads a day
    // short here; date-part arithmetic does not.
    expect(deriveReturnDate(utc('2026-03-27'), 1, 'days')).toBe('2026-03-30');
    expect(deriveReturnDate(utc('2026-03-25'), 2, 'weeks')).toBe('2026-04-08');
  });
});

describe('isValidTenderReturnPeriod', () => {
  it('accepts each unit up to its own maximum and no further', () => {
    expect(TENDER_RETURN_MAX).toEqual({ days: 5, weeks: 8 });
    expect(isValidTenderReturnPeriod(1, 'days')).toBe(true);
    expect(isValidTenderReturnPeriod(5, 'days')).toBe(true);
    expect(isValidTenderReturnPeriod(6, 'days')).toBe(false);
    expect(isValidTenderReturnPeriod(8, 'weeks')).toBe(true);
    expect(isValidTenderReturnPeriod(9, 'weeks')).toBe(false);
  });

  it('rejects zero, negatives and fractions', () => {
    expect(isValidTenderReturnPeriod(0, 'weeks')).toBe(false);
    expect(isValidTenderReturnPeriod(-1, 'days')).toBe(false);
    expect(isValidTenderReturnPeriod(2.5, 'weeks')).toBe(false);
  });
});
