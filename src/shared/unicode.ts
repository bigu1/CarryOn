/** 全文统一：引用偏移按 Unicode 码点（Array.from），覆盖中文、emoji、重复句。 */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function sliceCp(text: string, start: number, end: number): string {
  return codePoints(text).slice(start, end).join("");
}

export function indexOfCp(haystack: string, needle: string, fromCp = 0): number {
  const h = codePoints(haystack);
  const n = codePoints(needle);
  if (n.length === 0) return fromCp;
  for (let i = fromCp; i <= h.length - n.length; i++) {
    let ok = true;
    for (let j = 0; j < n.length; j++) {
      if (h[i + j] !== n[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
