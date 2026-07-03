/** Run a command, capture stdout, throw on non-zero exit. Inherits process env
 *  (tests override PATH via process.env to swap in the fake `gh`). */
export async function run(cmd: string[], cwd?: string): Promise<string> {
  // Pass live env explicitly: Bun.spawn otherwise snapshots PATH at startup,
  // which defeats the test PATH shim for `gh`.
  const proc = Bun.spawn(cmd, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}
