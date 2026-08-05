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
