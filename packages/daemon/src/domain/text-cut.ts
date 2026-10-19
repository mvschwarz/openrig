/** First `end` UTF-16 units of `text`, one shorter when the cut would land between the
 *  two halves of a surrogate pair, so a truncated preview never ends in half an emoji. */
export function sliceWhole(text: string, end: number): string {
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}
