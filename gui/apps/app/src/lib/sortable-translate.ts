// A sortable item's drag offset as a CSS transform, in whole pixels: the same
// string as dnd-kit's CSS.Translate.toString (from @dnd-kit/utilities).
export function sortableTranslate(
  transform: { x: number; y: number } | null,
): string | undefined {
  if (!transform) return undefined;
  const { x, y } = transform;
  return `translate3d(${x ? Math.round(x) : 0}px, ${y ? Math.round(y) : 0}px, 0)`;
}
