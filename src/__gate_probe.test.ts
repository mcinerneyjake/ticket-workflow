// TEMPORARY probe — asserts the gate aggregator goes RED when one matrix leg
// fails. Fails on the Node 20 leg, passes on 22, so `suite` is half-red and
// `gate` must report failure rather than skip. Never merge; delete the branch.
import { it, expect } from 'vitest';

it('fails only on the Node 20 leg', () => {
  expect(process.versions.node.split('.')[0]).not.toBe('20');
});
