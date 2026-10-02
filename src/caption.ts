// Remove mention spans only. Keep punctuation, whitespace, line breaks and
// hashtags byte-for-byte; a trailing full stop belongs to the surrounding text.
export function withoutMentions(original: string): string {
  return original.replace(/@[\p{L}\p{M}\p{N}_.]*[\p{L}\p{M}\p{N}_]/gu, '');
}
