import { z } from 'zod';

/**
 * The cross-repo contract with BuildFlow.
 *
 * BuildFlow publishes here when a take-off completes; TPS launches a tender preparation
 * workflow from it. The queue name must stay byte-identical to TAKEOFF_COMPLETION_QUEUE
 * in nrm-seed-generator's apps/bff/src/queues.ts — it is a contract, not a local name,
 * which is why it does not follow either repo's naming convention.
 */
export const TAKEOFF_COMPLETION_QUEUE = 'buildflow_takeoff_completion_queue';

/**
 * `tenderId` and its siblings are `.nullable()`, not `.optional()`: a package need not
 * belong to a tender (bf_takeoff_packages.tender_id is nullable), and the producer emits
 * the key with a JSON null rather than omitting it — so "this package has no tender" and
 * "the producer sent a malformed message" stay distinguishable.
 *
 * Everything past `requestedBy` is context for the Tender Launch Pack step. Unknown keys
 * are ignored rather than rejected, so BuildFlow can add fields without a lockstep deploy.
 */
export const takeoffCompletionMessage = z.object({
  takeoffId: z.string().min(1),
  pipelineSessionId: z.string().nullable().optional(),
  source: z.string().optional(),
  analysisRunId: z.string().uuid().nullable().optional(),
  takeoffRunId: z.string().uuid().nullable().optional(),

  // The two the workflow cannot be created without — both NOT NULL upstream.
  packageId: z.string().uuid(),
  organizationId: z.string().uuid(),
  requestedBy: z.string().uuid(),

  projectId: z.string().uuid().nullable().optional(),
  projectName: z.string().nullable().optional(),
  packageName: z.string().nullable().optional(),
  packageVersionId: z.string().uuid().nullable().optional(),
  versionNumber: z.number().nullable().optional(),
  revision: z.number().nullable().optional(),
  tenderId: z.string().uuid().nullable(),
  tenderName: z.string().nullable(),
  tenderReference: z.string().nullable(),
  itemCount: z.number().nullable().optional(),
  gifaM2: z.union([z.number(), z.string()]).nullable().optional(),
  completedAt: z.string().nullable().optional()
});

export type TakeoffCompletion = z.infer<typeof takeoffCompletionMessage>;

/**
 * The second half of the same contract, published when a reviewer releases a take-off to
 * tender. Byte-identical to TAKEOFF_TENDER_QUEUE in nrm-seed-generator's queues.ts.
 *
 * Two topics rather than one because they answer different questions and can be arbitrarily
 * far apart in time: `completed` says the pipeline finished measuring and creates the
 * workflow shell; `tendered` says a human has approved or ignored every item, and is what
 * builds the package list. A take-off can sit completed-but-unreviewed indefinitely.
 */
export const TAKEOFF_TENDER_QUEUE = 'buildflow_takeoff_tender_queue';

/**
 * Extends the completion shape — same identity fields, so nothing about reading a message
 * changes — with the two facts the package rule needs.
 *
 * `projectScope` is `.nullable()`, not defaulted: a project that has never been given a
 * scope selects the same packages as one explicitly scoped `works`, but they are different
 * facts and only one of them is worth telling a user about.
 *
 * `workPackages` is what the take-off actually resolved, as at the moment it was released.
 * It travels in the message rather than being re-queried here on purpose — re-reading
 * takeoff_items later would silently answer for whatever has happened since.
 */
export const takeoffTenderedMessage = takeoffCompletionMessage.extend({
  projectScope: z.string().nullable().optional(),
  workPackages: z.array(z.object({
    wpCode: z.string().min(1),
    itemCount: z.number()
  })).default([]),
  tenderedAt: z.string().nullable().optional()
});

export type TakeoffTendered = z.infer<typeof takeoffTenderedMessage>;
