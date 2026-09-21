/**
 * Walks a simulated tender timeline and emails the reminders to a TEST INBOX, not to firms.
 *
 *   pnpm --filter @tps/bff send-test-reminders -- --as-of 2026-10-08 --as-of 2026-10-15
 *   pnpm --filter @tps/bff send-test-reminders -- --reset
 *
 * This is the run issue #36 asks for: "simulate timeline using vipvyas@novamerx.ai as test
 * email to generate the emails". Set TEST_EMAIL_FLAG=Y, TEST_FROM_EMAIL_ACCOUNT and
 * TEST_TO_EMAIL_ACCOUNT=vipvyas@novamerx.ai in .env, then give it the dates to pretend it is.
 * Each `--as-of` is one scheduled run, in the order given, so
 *
 *     --as-of <day 7> --as-of <day 14>
 *
 * shows the confirm-interest reminder on the first and the submit-tender one on the second.
 *
 * REFUSES TO RUN unless TEST_EMAIL_FLAG is Y, exactly as sendTestItt.ts does: this reads real
 * tenders and real subcontractor shortlists, and the redirect is the only thing between it and
 * a real firm's inbox.
 *
 * WHAT IT LEAVES BEHIND. Reminders sent this way are recorded as TEST (`is_test`), so they can
 * neither use up a real firm's once-only reminder nor be mistaken for one, and each writes a
 * "[TEST]" entry on the firm's comms timeline. `--reset` removes every one of them, and the
 * timeline entries with them. Real reminders are never selected by it.
 *
 * ONLY ORGANISATIONS THAT HAVE SWITCHED REMINDERS ON are considered, same as the real run - so
 * switch it on in Configuration -> Tender communications first, or nothing will send.
 */
import { CommsDatabase } from './commsDb.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { EmailService } from './emailService.js';
import { IttRemindersDatabase } from './ittRemindersDb.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { ITT_FROM_ADDRESS } from './tenderPrepDb.js';

const config = loadConfig();

if (!config.TEST_EMAIL_FLAG) {
  console.error('Refusing to run: TEST_EMAIL_FLAG is not Y. Set TEST_EMAIL_FLAG=Y, TEST_FROM_EMAIL_ACCOUNT and TEST_TO_EMAIL_ACCOUNT in .env first.');
  process.exit(1);
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const reset = args.includes('--reset');
const dates: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--as-of') {
    const value = args[i + 1];
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      console.error('--as-of needs a date, e.g. --as-of 2026-10-08');
      process.exit(1);
    }
    dates.push(value);
    i += 1;
  }
}
if (!reset && dates.length === 0) {
  console.error('Give it at least one --as-of YYYY-MM-DD, or --reset to remove what earlier runs left behind.');
  process.exit(1);
}

const db = new Database(config);
const testEmailOverride = { from: config.TEST_FROM_EMAIL_ACCOUNT!, to: config.TEST_TO_EMAIL_ACCOUNT! };
const emailService = config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_EMAIL_TOKEN
  ? new EmailService({ cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: config.CLOUDFLARE_EMAIL_TOKEN })
  : undefined;
const reminders = new IttRemindersDatabase(
  db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new CommsDatabase(db), emailService, testEmailOverride,
  config.PORTAL_BASE_URL ?? config.WEB_ORIGIN[0], ITT_FROM_ADDRESS
);

try {
  if (reset) {
    const removed = await reminders.resetTestReminders();
    console.log(`Removed ${removed} test reminder(s) and their timeline entries.`);
  }

  if (dates.length > 0 && !emailService) {
    console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_TOKEN are not set, so nothing can be emailed. Every reminder would be recorded as failed.');
    process.exit(1);
  }

  console.log(`Simulated run (every email redirected to ${testEmailOverride.to}):`);
  for (const date of dates) {
    // 00:30, the time the real task runs. The rule works in whole UTC days, so this only
    // makes the log line read like the schedule.
    const asOf = new Date(`${date}T00:30:00Z`);
    const summary = await reminders.runDue(asOf);
    console.log(`\n${date}  considered ${summary.considered} invitation(s)`);
    console.log(`  sent: ${summary.sent.confirm_interest} confirm-interest, ${summary.sent.submit_tender} submit-tender`
      + (summary.failed ? `, ${summary.failed} FAILED` : '')
      + (summary.skippedNoEmail ? `, ${summary.skippedNoEmail} skipped (no email on file)` : ''));
    const why = Object.entries(summary.skipped);
    if (why.length > 0) console.log(`  not sent: ${why.map(([reason, n]) => `${n} ${reason}`).join(', ')}`);
    for (const r of summary.recipients) {
      console.log(`    - ${r.kind} -> ${r.status}${r.error ? ` (${r.error})` : ''}  entry ${r.shortlistEntryId}`);
    }
    if (summary.stuckPending > 0) console.log(`  WARNING: ${summary.stuckPending} reminder claim(s) never resolved - see itt_reminders.`);
  }
} finally {
  await db.close();
}
