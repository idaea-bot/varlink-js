// Grandchild for activation-child.ts --grandchild: prints, as one JSON object on stdout, what /proc/self/fd/<n> is
// for each fd number in argv (null: closed, or no /proc).
import { readlinkSync } from "node:fs";

const out: Record<string, string | null> = {};
for (const fd of process.argv.slice(2))
  try {
    out[fd] = readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    out[fd] = null;
  }
process.stdout.write(JSON.stringify(out));
