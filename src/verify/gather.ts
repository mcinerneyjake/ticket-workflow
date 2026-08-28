/**
 * Definition-of-Done verification — the board-reading half (tkt-ec7743588066).
 *
 * Reads through the service layer (`listBoard`, `readEvents`) rather than the filesystem, so `verify`
 * sees exactly the board every other consumer sees, including its `unreadable` files.
 */

import { listBoard, HttpError } from '../server/tickets.js';
import { readEvents, REVIEW_CLEARED } from '../server/events.js';
import { HOOK_ONLY_STEPS, parseTestsClaim, type TicketFacts } from './rules.js';

export interface GatherOptions {
  /**
   * Only these statuses are considered; `null` means every status. Defaults to the closed ones,
   * because a ticket still in flight has not made its claim yet and would be UNKNOWN for a reason
   * that says nothing about the work.
   */
  readonly statuses?: readonly string[] | null;
  readonly project?: string | null;
  /** A single ticket id, for `verify <id>`. */
  readonly id?: string | null;
}

export interface GatherResult {
  readonly facts: TicketFacts[];
  /** Ticket files that would not parse. Board-wide and never filtered — they are absent from `facts`,
   *  so a count taken without them understates what was NOT checked. */
  readonly unreadable: number;
}

const CLOSED = ['done', 'archived'];

export async function gatherTicketFacts(opts: GatherOptions = {}): Promise<GatherResult> {
  const { tickets, unreadable } = await listBoard();
  // `undefined` means "not specified" → the closed default; `null` means "every status". `??` alone
  // would collapse the two and make --all silently equivalent to the default.
  const statuses = opts.statuses === undefined ? CLOSED : opts.statuses;

  // `!= null`, not truthiness: `verify "$ID"` with an unset variable passes an empty string, and a
  // falsy check would drop the filter and silently report on the entire board instead.
  const wantsOne = opts.id !== undefined && opts.id !== null;
  const selected = tickets.filter((t) => {
    if (wantsOne) return t.id === opts.id;
    if (statuses !== null && !statuses.includes(t.status)) return false;
    if (opts.project && t.project !== opts.project) return false;
    return true;
  });

  // A named ticket that matches nothing is an ERROR, not an empty clean run. `parseVerifyArgs`
  // already refuses an unrecognised flag for this reason; a typo'd id deserves the same, or a
  // renamed ticket reads as "checked, nothing wrong".
  if (wantsOne && selected.length === 0) {
    throw new HttpError(404, `Ticket not found: ${opts.id === '' ? '(empty id)' : opts.id}`);
  }

  const facts: TicketFacts[] = [];
  for (const t of selected) {
    const base = { id: t.id, title: t.title, status: t.status, claim: parseTestsClaim(t.body) };
    let events, skipped: number, unrecognized: number;
    try {
      // readEvents returns empty only for ENOENT; any other fault throws (tkt-fc7c6846903d).
      ({ events, skipped, unrecognized } = await readEvents(t.id));
    } catch {
      // Caught PER TICKET, and turned into an honest UNKNOWN rather than swallowed. Letting it
      // propagate discards the finished report for every other ticket on a 700-ticket board because
      // one log was unreadable — while pretending the log was empty would be the permissive answer.
      facts.push({ ...base, steps: {}, skippedLines: 0, unrecognizedLines: 0, unreadableLog: true, trustedSteps: {} });
      continue;
    }
    // Trust is recorded PER STEP and read from the same event that supplied the step's state, so
    // the two can never come from different rows. Only hook-written steps carry an outcome at all;
    // the service writes started/qa/done, which assert nothing about how a command went.
    const trustedSteps: Record<string, boolean> = {};
    const steps: Record<string, string> = {};
    // Last write wins, and a `cleared` marker reverts the step — mirroring reducePipeline, so this
    // predicate and the pipeline the board renders can never disagree about what a step's state is.
    for (const e of events) {
      steps[e.step] = e.detail === REVIEW_CLEARED ? '' : e.state;
      if (HOOK_ONLY_STEPS.some((s) => s === e.step)) trustedSteps[e.step] = e.outcomeFrom === 'event';
    }
    for (const [k, v] of Object.entries(steps)) if (v === '') { delete steps[k]; delete trustedSteps[k]; }
    facts.push({ ...base, steps, skippedLines: skipped, unrecognizedLines: unrecognized, unreadableLog: false, trustedSteps });
  }
  return { facts, unreadable: unreadable.length };
}
