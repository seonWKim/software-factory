/** Joins class names, skipping false, null and undefined (shadcn's `cn` without the merge dependency). */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
