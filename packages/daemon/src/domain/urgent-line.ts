/** The line an urgent message is typed under, naming who marked it. One place adds it, and only once: a body that already
 *  carries it (a held wake delivered later, a frozen staged envelope) is left as it is. */
export function withUrgentLine(text: string, by: string): string {
  const line = `Urgent (marked by ${by}):`;
  return text.includes(line) ? text : `${line}\n${text}`;
}
