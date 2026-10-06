// orca.config now requires ORCA_DEV_ROOT (fails loudly otherwise). Give the test suite a default so
// files that import orca.config (e.g. previewPreflight.test.ts) don't throw at import time. Real
// runs still require the operator to set it; this only covers the test process.
process.env.ORCA_DEV_ROOT ??= `${process.env.HOME}/Documents`;
// server/preview.ts persists its registry to TMPDIR/orca-previews.json at import-time-resolved path,
// and a test's start/stop rewrites it with only the test's previews — which once wiped the LIVE
// bridge's registry. Every test process gets its own TMPDIR, set here before anything imports it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "orca-test-"));
