// What an fd number is, by fstat (any POSIX system, every runtime): for the /dev/null cover tests.
import { fstatSync, statSync } from "node:fs";

/** `devnull` (the /dev/null dev + inode), `chr` (another character device), `socket`, `other`, or `null` (closed). */
export type FdKind = "devnull" | "chr" | "socket" | "other" | null;

export function fdKind(fd: number): FdKind {
  let st;
  try {
    st = fstatSync(fd);
  } catch {
    return null;
  }
  if (st.isSocket()) return "socket";
  if (!st.isCharacterDevice()) return "other";
  const devNull = statSync("/dev/null");
  return st.dev === devNull.dev && st.ino === devNull.ino ? "devnull" : "chr";
}
