/**
 * Tiny line-by-line diff. Not meant to be a full Myers — it just produces a
 * human-readable preview for write_file/edit_file tool results.
 */
export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

export function lineDiff(before: string, after: string, contextLines = 3): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  // Longest common subsequence via dynamic programming. Fine for previews.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
      }
    }
  }

  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: "del", text: a[i] ?? "" });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j] ?? "" });
    j += 1;
  }

  return collapseContext(ops, contextLines);
}

function collapseContext(ops: DiffLine[], contextLines: number): DiffLine[] {
  if (ops.length === 0) return ops;
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k]!.kind !== "ctx") {
      const lo = Math.max(0, k - contextLines);
      const hi = Math.min(ops.length - 1, k + contextLines);
      for (let p = lo; p <= hi; p += 1) keep[p] = true;
    }
  }
  const out: DiffLine[] = [];
  let lastKept = -2;
  for (let k = 0; k < ops.length; k += 1) {
    if (keep[k]) {
      if (lastKept >= 0 && k - lastKept > 1) {
        out.push({ kind: "ctx", text: "…" });
      }
      out.push(ops[k]!);
      lastKept = k;
    }
  }
  return out;
}
