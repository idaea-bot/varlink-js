// Grandchild for activation-child.ts --grandchild: prints, as one JSON object on stdout, for each fd number in argv,
// what /proc/self/fd/<n> is (`links`; null: closed, or no /proc) and what fstat says it is (`kinds`, see fdKind).
import { readlinkSync } from "node:fs";
import { fdKind, type FdKind } from "./fd-kind.ts";

const links: Record<string, string | null> = {};
const kinds: Record<string, FdKind> = {};
for (const fd of process.argv.slice(2)) {
  try {
    links[fd] = readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    links[fd] = null;
  }
  kinds[fd] = fdKind(Number(fd));
}
process.stdout.write(JSON.stringify({ links, kinds }));
