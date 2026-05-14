// 16-color palette, r/place inspired. Index 0 = empty/white.
export const PALETTE: readonly string[] = [
  "#FFFFFF", // 0  white (empty)
  "#E4E4E4", // 1  light gray
  "#888888", // 2  gray
  "#222222", // 3  black
  "#FFA7D1", // 4  pink
  "#E50000", // 5  red
  "#E59500", // 6  orange
  "#A06A42", // 7  brown
  "#E5D900", // 8  yellow
  "#94E044", // 9  light green
  "#02BE01", // 10 green
  "#00D3DD", // 11 cyan
  "#0083C7", // 12 blue
  "#0000EA", // 13 dark blue
  "#CF6EE4", // 14 magenta
  "#820080", // 15 purple
];

export function isValidColorIndex(c: number): boolean {
  return Number.isInteger(c) && c >= 0 && c < PALETTE.length;
}

export function hexToRgba(hex: string): [number, number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, 255];
}
