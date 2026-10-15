import type { InboundMessage } from "./mailbox/types.ts";

/** A running container whose heartbeat passed this age without activity is replaced. */
export const HEARTBEAT_CEILING_MS = 30 * 60 * 1000;
/** A processing claim older than this without later activity is replaced. */
export const CLAIM_STALL_MS = 60 * 1000;
/** Waits before the five recovery retries that follow the initial attempt. */
export const RECOVERY_WAIT_SECONDS = [5, 10, 20, 40, 80] as const;

/**
 * Wait before the next recovery attempt for a claim whose `tries` counts
 * completed attempts, or undefined once recovery retries are exhausted.
 */
export function recoveryWaitSeconds(tries: number): number | undefined {
  return RECOVERY_WAIT_SECONDS[tries];
}

export interface ActiveTool {
  name: string;
  declaredTimeoutMs: number | null;
}

export interface ProcessingClaim {
  messageId: string;
  claimedAtMs: number;
}

export type StallDecision =
  | { action: "keep" }
  | { action: "replace"; reason: "stalled"; heartbeatAgeMs: number; ceilingMs: number }
  | {
      action: "replace";
      reason: "claim";
      messageId: string;
      claimAgeMs: number;
      toleranceMs: number;
    };

/**
 * Decide whether a running session container still shows progress. All inputs
 * are observations; the caller supplies the clock and file/mailbox reads.
 */
export function decideStallAction(input: {
  now: number;
  /** Epoch ms of the last observed heartbeat, or 0 when none was ever written. */
  heartbeatAtMs: number;
  /** Epoch ms of the current container incarnation, used when no heartbeat exists. */
  startedAtMs: number;
  activeTool: ActiveTool | null;
  claims: ProcessingClaim[];
}): StallDecision {
  const declaredTimeoutMs = input.activeTool?.declaredTimeoutMs ?? 0;
  const ceilingMs = Math.max(HEARTBEAT_CEILING_MS, declaredTimeoutMs);
  const effectiveHeartbeatMs = input.heartbeatAtMs !== 0 ? input.heartbeatAtMs : input.startedAtMs;
  if (effectiveHeartbeatMs !== 0) {
    const heartbeatAgeMs = input.now - effectiveHeartbeatMs;
    if (heartbeatAgeMs > ceilingMs)
      return { action: "replace", reason: "stalled", heartbeatAgeMs, ceilingMs };
  }
  const toleranceMs = Math.max(CLAIM_STALL_MS, declaredTimeoutMs);
  for (const claim of input.claims) {
    const claimAgeMs = input.now - claim.claimedAtMs;
    if (claimAgeMs <= toleranceMs) continue;
    if (input.heartbeatAtMs > claim.claimedAtMs) continue;
    return {
      action: "replace",
      reason: "claim",
      messageId: claim.messageId,
      claimAgeMs,
      toleranceMs,
    };
  }
  return { action: "keep" };
}

/** Host-side mailbox reads and writes needed to recover abandoned processing claims. */
export interface RecoveryMailbox {
  inputs(): InboundMessage[];
  processingClaims(): { message_id: string; status: string }[];
  clearProcessingClaims(): void;
  retryInput(id: string, processAfter: string): void;
  failInput(id: string): void;
}

export interface RecoveryOutcome {
  retried: string[];
  failed: string[];
}

/**
 * Reschedule or fail input whose container abandoned a `processing` claim.
 * Completed and failed input keeps its terminal state; only unfinished
 * claims are recovered. Orphan claims are removed once a container stopped.
 */
export function recoverAbandonedClaims(mailbox: RecoveryMailbox, now: number): RecoveryOutcome {
  const outcome: RecoveryOutcome = { retried: [], failed: [] };
  for (const claim of mailbox.processingClaims()) {
    const input = mailbox.inputs().find((candidate) => candidate.id === claim.message_id);
    if (input?.status !== "pending") continue;
    const scheduled = input.process_after ? Date.parse(input.process_after) : undefined;
    // Already rescheduled for a future attempt; do not count it twice.
    if (scheduled !== undefined && scheduled > now) continue;
    const wait = recoveryWaitSeconds(input.tries);
    if (wait === undefined) {
      mailbox.failInput(input.id);
      outcome.failed.push(input.id);
    } else {
      mailbox.retryInput(input.id, new Date(now + wait * 1000).toISOString());
      outcome.retried.push(input.id);
    }
  }
  mailbox.clearProcessingClaims();
  return outcome;
}
