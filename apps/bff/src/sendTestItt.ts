import { BoqReadDatabase } from './boqReadDb.js';
import { BuildflowDocumentBundlesClient } from './buildflowDocumentBundlesClient.js';
import { BuildflowDocumentLinksClient } from './buildflowDocumentLinksClient.js';
import { BuildflowMepBoqClient } from './buildflowMepBoqClient.js';
import { BuildflowSpecClauseClient } from './buildflowSpecClauseClient.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { DropboxDocumentLinkProvider } from './documentLinkProvider.js';
import { EmailService } from './emailService.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';
import { systemActor, type Actor } from './types.js';

const config = loadConfig();

// Real confirmed packages, real subcontractor shortlists — refuse to run unless test-mode
// redirect is on, so this script can never accidentally email a live subcontractor.
if (!config.TEST_EMAIL_FLAG) {
  console.error('Refusing to run: TEST_EMAIL_FLAG is not Y. Set TEST_EMAIL_FLAG=Y, TEST_FROM_EMAIL_ACCOUNT and TEST_TO_EMAIL_ACCOUNT in .env first.');
  process.exit(1);
}

const packageSeqs = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['41', '42', '45']).map(Number);

const db = new Database(config);
const scmsDb = new ScmsReadDatabase(db, config.SCMS_SCHEMA);
const boqDb = new BoqReadDatabase(db);
const documentLinks = config.DROPBOX_ACCESS_TOKEN
  ? new DropboxDocumentLinkProvider(config.DROPBOX_ACCESS_TOKEN)
  : undefined;
const buildflowLinks = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
  ? new BuildflowDocumentLinksClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
  : undefined;
const specClauses = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
  ? new BuildflowSpecClauseClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
  : undefined;
const mepBoq = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
  ? new BuildflowMepBoqClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
  : undefined;
const documentBundles = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
  ? new BuildflowDocumentBundlesClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
  : undefined;
const emailService = config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_EMAIL_TOKEN
  ? new EmailService({ cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: config.CLOUDFLARE_EMAIL_TOKEN })
  : undefined;
const testEmailOverride = { from: config.TEST_FROM_EMAIL_ACCOUNT!, to: config.TEST_TO_EMAIL_ACCOUNT! };
const tpDb = new TenderPrepDatabase(db, scmsDb, boqDb, documentLinks, buildflowLinks, specClauses, documentBundles,
  emailService, testEmailOverride, undefined, undefined, undefined, 90, mepBoq);

const packages = await db.query<{ workflow_id: string; package_name: string }>(
  `SELECT workflow_id, package_name FROM shortlists WHERE package_seq = ANY($1) ORDER BY package_seq`,
  [packageSeqs]
);

if (packages.length === 0) {
  console.error(`No shortlists found for package_seq ${packageSeqs.join(', ')}`);
  process.exit(1);
}

console.log(`Sending test ITTs (redirected to ${testEmailOverride.to}) for ${packages.length} package(s):`);
for (const pkg of packages) {
  console.log(` - ${pkg.package_name} (workflow ${pkg.workflow_id})`);
}

for (const pkg of packages) {
  try {
    const orgRow = await db.one<{ organization_id: string }>(
      `SELECT organization_id FROM workflows WHERE id = $1`, [pkg.workflow_id]
    );
    const actor: Actor = systemActor({
      userId: '00000000-0000-0000-0000-000000000001',
      organizationId: String(orgRow.organization_id),
      subject: 'send-test-itt-script'
    });
    const result = await tpDb.confirmAndSendItt(actor, pkg.workflow_id, pkg.package_name);
    console.log(`\n${pkg.package_name}:`, result);
  } catch (error) {
    console.error(`\n${pkg.package_name}: FAILED —`, error instanceof Error ? error.message : error);
  }
}

await db.close();
