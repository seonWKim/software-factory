/** The ISO time `ms` milliseconds after `iso`. */
export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
