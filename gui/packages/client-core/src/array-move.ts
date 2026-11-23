export function arrayMove<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  const [moved] = result.splice(from, 1);
  if (moved !== undefined) result.splice(to, 0, moved);
  return result;
}
