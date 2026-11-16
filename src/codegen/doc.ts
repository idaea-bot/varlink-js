// A minimal Wadler-style document printer: the subset of prettier's algorithm (group, indent, align, line,
// softline, hardline, ifBreak) that generate() needs to emit code prettier leaves unchanged (DESIGN.md §4.13).

/** A layout document. */
export type Doc = string | Doc[] | DocNode;

type DocNode =
  | { readonly t: "group"; readonly contents: Doc; broken: boolean }
  | { readonly t: "indent"; readonly n: number; readonly contents: Doc }
  | { readonly t: "line"; readonly soft: boolean; readonly hard: boolean }
  | { readonly t: "ifBreak"; readonly broken: Doc; readonly flat: Doc };

/** Printed flat when it fits in the rest of the line, else broken (its lines become newlines). */
export function group(contents: Doc): Doc {
  return { t: "group", contents, broken: false };
}

/** Indents the lines of `contents` by two more spaces. */
export function indent(contents: Doc): Doc {
  return { t: "indent", n: 2, contents };
}

/** Indents the lines of `contents` by `n` more spaces (prettier's `align`). */
export function align(n: number, contents: Doc): Doc {
  return { t: "indent", n, contents };
}

/** A space when flat, a newline when broken. */
export const line: Doc = { t: "line", soft: false, hard: false };
/** Nothing when flat, a newline when broken. */
export const softline: Doc = { t: "line", soft: true, hard: false };
/** Always a newline; breaks every enclosing group. */
export const hardline: Doc = { t: "line", soft: false, hard: true };

/** `broken` in a broken group, `flat` in a flat one. */
export function ifBreak(broken: Doc, flat: Doc = ""): Doc {
  return { t: "ifBreak", broken, flat };
}

/** `docs` separated by `sep`. */
export function join(sep: Doc, docs: readonly Doc[]): Doc[] {
  const out: Doc[] = [];
  docs.forEach((d, i) => {
    if (i > 0) out.push(sep);
    out.push(d);
  });
  return out;
}

/** Marks every group that contains a hardline as broken; returns whether `doc` contains one. */
function propagate(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (Array.isArray(doc)) {
    let hard = false;
    for (const d of doc) if (propagate(d)) hard = true;
    return hard;
  }
  switch (doc.t) {
    case "group": {
      const hard = propagate(doc.contents);
      if (hard) doc.broken = true;
      return hard;
    }
    case "indent":
      return propagate(doc.contents);
    case "line":
      return doc.hard;
    case "ifBreak": {
      const a = propagate(doc.broken);
      const b = propagate(doc.flat);
      return a || b;
    }
  }
}

type Mode = "flat" | "break";
interface Cmd {
  readonly ind: number;
  readonly mode: Mode;
  readonly doc: Doc;
}

/** Whether `next` fits in `width` columns, followed by the rest of the line from `rest`. */
function fits(next: Cmd, rest: readonly Cmd[], width: number): boolean {
  const cmds: { mode: Mode; doc: Doc }[] = [next];
  let restIdx = rest.length;
  let remaining = width;
  while (remaining >= 0) {
    const cmd = cmds.pop();
    if (cmd === undefined) {
      if (restIdx === 0) return true;
      const r = rest[--restIdx];
      if (r === undefined) return true;
      cmds.push(r);
      continue;
    }
    const { mode, doc } = cmd;
    if (typeof doc === "string") {
      remaining -= doc.length;
    } else if (Array.isArray(doc)) {
      for (let i = doc.length - 1; i >= 0; i--) cmds.push({ mode, doc: doc[i] ?? "" });
    } else {
      switch (doc.t) {
        case "group":
          cmds.push({ mode: doc.broken ? "break" : mode, doc: doc.contents });
          break;
        case "indent":
          cmds.push({ mode, doc: doc.contents });
          break;
        case "ifBreak":
          cmds.push({ mode, doc: mode === "break" ? doc.broken : doc.flat });
          break;
        case "line":
          if (mode === "break" || doc.hard) return true;
          if (!doc.soft) remaining -= 1;
          break;
      }
    }
  }
  return false;
}

/** Prints `doc` with lines of at most `width` columns where possible; trailing spaces before newlines are trimmed. */
export function print(doc: Doc, width: number): string {
  propagate(doc);
  const out: string[] = [];
  let pos = 0;
  const cmds: Cmd[] = [{ ind: 0, mode: "break", doc }];
  for (;;) {
    const cmd = cmds.pop();
    if (cmd === undefined) break;
    const { ind, mode, doc: d } = cmd;
    if (typeof d === "string") {
      out.push(d);
      const nl = d.lastIndexOf("\n");
      pos = nl < 0 ? pos + d.length : d.length - nl - 1;
      continue;
    }
    if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) cmds.push({ ind, mode, doc: d[i] ?? "" });
      continue;
    }
    switch (d.t) {
      case "group": {
        const flat: Cmd = { ind, mode: "flat", doc: d.contents };
        if (mode === "flat" && !d.broken) cmds.push(flat);
        else if (!d.broken && fits(flat, cmds, width - pos)) cmds.push(flat);
        else cmds.push({ ind, mode: "break", doc: d.contents });
        break;
      }
      case "indent":
        cmds.push({ ind: ind + d.n, mode, doc: d.contents });
        break;
      case "ifBreak":
        cmds.push({ ind, mode, doc: mode === "break" ? d.broken : d.flat });
        break;
      case "line":
        if (mode === "flat" && !d.hard) {
          if (!d.soft) {
            out.push(" ");
            pos += 1;
          }
          break;
        }
        trimTrailing(out);
        out.push("\n" + " ".repeat(ind));
        pos = ind;
        break;
    }
  }
  return out.join("");
}

/** Removes spaces and tabs at the end of the output so far. */
function trimTrailing(out: string[]): void {
  for (;;) {
    const last = out.pop();
    if (last === undefined) return;
    const trimmed = last.replace(/[ \t]+$/, "");
    if (trimmed.length > 0) {
      out.push(trimmed);
      return;
    }
  }
}
