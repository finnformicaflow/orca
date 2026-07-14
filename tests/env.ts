// orca.config now requires ORCA_DEV_ROOT (fails loudly otherwise). Give the test suite a default so
// files that import orca.config (e.g. previewPreflight.test.ts) don't throw at import time. Real
// runs still require the operator to set it; this only covers the test process.
process.env.ORCA_DEV_ROOT ??= `${process.env.HOME}/Documents`;
