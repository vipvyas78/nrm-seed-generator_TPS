/** Issue #37's authorisation matrix, shared with BuildFlow via public.bf_authorisation_levels. */
export type AuthorisationLevel = 'L2' | 'L3' | 'L4';

export interface Actor {
  userId: string;
  organizationId: string;
  subject: string;
  email?: string;
  displayName?: string;
  /**
   * Issue #37. Read from `public.bf_organization_memberships` on every request — the
   * same row BuildFlow reads, because there is one identity store and one matrix across
   * both applications. A level the Board revokes takes effect here on the revoked user's
   * next call, not when their session lapses.
   */
  authorisationLevel: AuthorisationLevel;
  canApprove: boolean;
  seesAllTenders: boolean;
  /** Present for a local (database) session only; absent for OIDC and dev headers. */
  sessionId?: string;
}

/**
 * An actor for work the application does on its own behalf: a queue consumer handling a
 * `takeoff.completed` message, BuildFlow calling an `/internal/*` route, a CLI script.
 *
 * It carries L4 because it is not a person and the authorisation matrix describes people
 * (issue #37). Nothing here passes through the approval gate — none of these paths is on
 * the authenticated plugin — so the level is provenance rather than permission, and
 * saying so explicitly beats four literals that each happen to name a level.
 *
 * The audit trail tells them apart by `actor_kind = 'system'`, not by the level.
 */
export function systemActor(input: { userId: string; organizationId: string; subject: string; email?: string }): Actor {
  return {
    ...input,
    authorisationLevel: 'L4',
    canApprove: true,
    seesAllTenders: true
  };
}
