// Web DOM suite runner. Every test file installs process-global window,
// fetch, and EventSource stubs and renders one Solid root, so each file must
// run in its own process. The harness is built once up front because Bun
// cannot apply the Solid JSX transform.
import { Glob } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd: string[]): number {
  const proc = Bun.spawnSync(cmd, {
    cwd: webRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exitCode ?? 1;
}

if (run(["bun", "x", "vite", "build", "--config", "vite.test.config.ts"]) !== 0) {
  process.exit(1);
}

const files = [...new Glob("test/*.test.ts").scanSync({ cwd: webRoot })].sort();
for (const file of files) {
  const code = run(["bun", "test", file]);
  if (code !== 0) process.exit(code);
}

console.log(`web suite: ${files.length} files passed`);
