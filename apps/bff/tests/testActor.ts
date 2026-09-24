import type { Actor, AuthorisationLevel } from '../src/types.js';

/**
 * An `Actor` for a test, at a chosen authorisation level.
 *
 * Issue #37 added three fields to `Actor` that every suite would otherwise spell out
 * identically. The default is `L4` because these suites exercise whole flows including
 * the sends and approvals an L2 is not permitted; a test that means to check a REFUSAL
 * passes `'L2'` explicitly, which is the point — the level is then visible in the test
 * that depends on it rather than inherited from a fixture.
 *
 * Mirrors `apps/bff/src/testActor.ts` in the BuildFlow repository, deliberately rather
 * than shared: the two `Actor` types are separate declarations in separate packages, and
 * a shared helper would need a shared package for three fields.
 */
export function testActor(
  input: { userId: string; organizationId: string; subject?: string; email?: string; displayName?: string },
  level: AuthorisationLevel = 'L4'
): Actor {
  return {
    userId: input.userId,
    organizationId: input.organizationId,
    subject: input.subject ?? `sub-${input.userId}`,
    email: input.email,
    displayName: input.displayName,
    authorisationLevel: level,
    canApprove: level !== 'L2',
    seesAllTenders: level === 'L4'
  };
}
