const words = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const omission = "…";

// Lowercasing can change string length (for example, İ → i + combining dot).
function originalOffset(text: string, lower: string, offset: number, roundUp = false): number {
  if (lower.length === text.length) return offset;
  let index = 0, folded = 0;
  for (const char of text) {
    const length = char.toLowerCase().length;
    if (folded + length > offset) return index + (roundUp ? char.length : 0);
    index += char.length; folded += length;
    if (folded === offset) return index;
  }
  return text.length;
}

export function excerpt(text: string, terms: string[] = [], maxBytes = 420) {
  const lower = text.toLowerCase();
  const first = terms.map(term => ({ at: lower.indexOf(term), term })).filter(match => match.at >= 0).sort((a, b) => a.at - b.at)[0];
  const clusters = graphemes.segment(text);
  const align = (offset: number) => clusters.containing(offset)?.index ?? offset;
  const at = first ? align(originalOffset(text, lower, first.at)) : 0;
  const last = first ? clusters.containing(originalOffset(text, lower, first.at + first.term.length, true) - 1) : undefined;
  const matchEnd = last ? last.index + last.segment.length : 0;
  let start = 0;
  if (at > 100) {
    const desired = at - 100;
    let windowStart = Math.max(0, desired - 60);
    if (/[\udc00-\udfff]/.test(text[windowStart])) windowStart--;
    let before: number | undefined, after: number | undefined;
    for (const segment of words.segment(text.slice(windowStart, matchEnd))) {
      const pos = windowStart + segment.index;
      // The first segment may itself have been clipped by the context window.
      if (pos > at || pos === windowStart && windowStart > 0 || !segment.isWordLike) continue;
      if (pos < desired) before = pos;
      else { after = pos; break; }
    }
    start = after ?? before ?? at;
  }
  start = align(start);
  // Leading context is selected by words, but charged in bytes. If it would
  // hide the match, try a later boundary, then the match's entire grapheme.
  const matchBudget = Math.max(0, maxBytes - Buffer.byteLength(`${omission}  ${omission}`));
  if (Buffer.byteLength(text.slice(start, matchEnd)) > matchBudget) {
    let later = at;
    for (const segment of words.segment(text.slice(start, at))) {
      const candidate = align(start + segment.index);
      if (candidate > start && segment.isWordLike && Buffer.byteLength(text.slice(candidate, matchEnd)) <= matchBudget) { later = candidate; break; }
    }
    start = later;
  }
  const prefix = start > 0 ? `${omission} ` : "", source = text.slice(start);
  if (Buffer.byteLength(prefix + source) <= maxBytes) return { excerpt: prefix + source, excerpt_truncated: start > 0 };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(prefix + ` ${omission}`));
  let end = 0, bytes = 0;
  for (const segment of graphemes.segment(source)) {
    bytes += Buffer.byteLength(segment.segment);
    if (bytes > budget) break;
    end = segment.index + segment.segment.length;
  }
  let wordEnd = 0;
  for (const segment of words.segment(source)) {
    const next = segment.index + segment.segment.length;
    if (next > end) break;
    if (/\S/u.test(segment.segment)) wordEnd = next;
  }
  // Do not drop the match or most of the context to finish an oversized token.
  if (wordEnd > 0 && wordEnd >= matchEnd - start && end - wordEnd <= 40) end = wordEnd;
  return { excerpt: `${prefix}${source.slice(0, end).trimEnd()} ${omission}`, excerpt_truncated: true };
}
