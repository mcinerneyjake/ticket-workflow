import { beforeEach } from 'vitest';
import { setLogger } from '../logger.js';

// The service's log lines go to the real stderr, which vitest does not intercept and so cannot
// attribute to the test that produced them — they print raw. Silencing by default keeps the suite
// readable; a test that needs to observe output installs its own capturing logger (its beforeEach
// runs after this one), and the two that assert the DEFAULT sink's channel call setLogger(null)
// explicitly, which makes that dependency visible rather than ambient.
beforeEach(() => {
  setLogger({ info: () => undefined, warn: () => undefined, error: () => undefined });
});
