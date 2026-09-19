/** Keep markdown links within the protocols the Console can safely display. */
export function safeMarkdownUrl(url: string): string {
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  return /^(https?|mailto):/i.test(url) ? url : '';
}
