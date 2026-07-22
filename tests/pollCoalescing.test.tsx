// The poll coalescer (store.ts): a caller arriving while a poll is in flight gets exactly one fresh
// poll chained after it, so an imperative refresh() reliably reflects a just-applied mutation.
// The failure this pins: when the in-flight poll REJECTS (a fetch blip, or the enrichment write
// throwing), the trailing slot must still be released. Reset it only on the fulfilled path and the
// slot keeps a rejected promise forever — every later mid-flight caller is handed that same promise
// and no poll ever runs again, so the board silently freezes until a reload.
import { expect, test } from "bun:test";
import { coalesced } from "@/store";

/** A run fn whose Nth call resolves/rejects on demand, so a test can order the interleavings. */
function controllable() {
  const gates: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  let calls = 0;
  const run = () => {
    calls++;
    return new Promise<void>((resolve, reject) => gates.push({ resolve, reject }));
  };
  return { run, gates, calls: () => calls };
}

test("releases the trailing slot when the in-flight poll rejects", async () => {
  const { run, gates, calls } = controllable();
  const poll = coalesced(run);

  const leading = poll();
  const trailing = poll(); // arrives mid-flight → takes the trailing slot
  expect(calls()).toBe(1); // coalesced: the second caller did NOT stack a duplicate run

  gates[0]!.reject(new Error("fetch failed"));
  await expect(leading).rejects.toThrow("fetch failed");

  // The trailing caller still gets its own fresh run — the leading failure isn't its failure.
  await Promise.resolve();
  expect(calls()).toBe(2);
  gates[1]!.resolve();
  await trailing;

  // The wedge: with the slot never cleared, this pair would be handed the stale rejected promise —
  // trailing2 would reject and its run would never be issued.
  const leading2 = poll();
  const trailing2 = poll();
  gates[2]!.resolve();
  await leading2;
  await Promise.resolve();
  expect(calls()).toBe(4); // trailing2 chained a run of its own rather than reusing a dead promise
  gates[3]!.resolve();
  await expect(trailing2).resolves.toBeUndefined();
});

test("a mid-flight caller gets a fresh run, not the in-flight poll's stale result", async () => {
  const { run, gates, calls } = controllable();
  const poll = coalesced(run);

  const leading = poll();
  const trailing = poll();
  gates[0]!.resolve();
  await leading;
  await Promise.resolve();

  expect(calls()).toBe(2); // chained after the first, reflecting state from AFTER the caller asked
  gates[1]!.resolve();
  await expect(trailing).resolves.toBeUndefined();
});
