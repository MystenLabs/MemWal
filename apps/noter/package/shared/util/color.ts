// color.ts

/**
 * Unified color palette with all Tailwind variants
 * Each color has name, description, and consistent styling classes
 * Frozen for V8 optimization
 */
const COLOR_PALETTE = Object.freeze([
  {
    name: "gray",
    description: "Neutral and balanced",
    hex: "#6b7280",
    background: "bg-[#E8E8E8] dark:bg-[#2A2A2A] text-primary",
    fillSecondary: "fill-[#E8E8E8] dark:fill-[#2A2A2A] text-primary",
    text: "text-gray-500",
    fill: "fill-gray-500",
    border: "border-gray-500",
  },
  {
    name: "brown",
    description: "Warm and earthy",
    hex: "#a16207",
    background: "bg-[#E8DDD6] dark:bg-[#3A2F28] text-primary",
    fillSecondary: "fill-[#E8DDD6] dark:fill-[#3A2F28] text-primary",
    text: "text-amber-700",
    fill: "fill-amber-700",
    border: "border-amber-700",
  },
  {
    name: "orange",
    description: "Warm and energetic",
    hex: "#f97316",
    background: "bg-[#F5E2D0] dark:bg-[#4A2F1C] text-primary",
    fillSecondary: "fill-[#F5E2D0] dark:fill-[#4A2F1C] text-primary",
    text: "text-orange-500",
    fill: "fill-orange-500",
    border: "border-orange-500",
  },
  {
    name: "yellow",
    description: "Bright and optimistic",
    hex: "#eab308",
    background: "bg-[#F6EBC2] dark:bg-[#4A3F1C] text-primary",
    fillSecondary: "fill-[#F6EBC2] dark:fill-[#4A3F1C] text-primary",
    text: "text-yellow-500",
    fill: "fill-yellow-500",
    border: "border-yellow-500",
  },
  {
    name: "green",
    description: "Success and growth",
    hex: "#22c55e",
    background: "bg-[#DDECE3] dark:bg-[#24352C] text-primary",
    fillSecondary: "fill-[#DDECE3] dark:fill-[#24352C] text-primary",
    text: "text-green-500",
    fill: "fill-green-500",
    border: "border-green-500",
  },
  {
    name: "blue",
    description: "Trust and stability",
    hex: "#3b82f6",
    background: "bg-[#DCE8F5] dark:bg-[#24314A] text-primary",
    fillSecondary: "fill-[#DCE8F5] dark:fill-[#24314A] text-primary",
    text: "text-blue-500",
    fill: "fill-blue-500",
    border: "border-blue-500",
  },
  {
    name: "purple",
    description: "Royal and luxurious",
    hex: "#a855f7",
    background: "bg-[#E6E0F3] dark:bg-[#2F2945] text-primary",
    fillSecondary: "fill-[#E6E0F3] dark:fill-[#2F2945] text-primary",
    text: "text-purple-500",
    fill: "fill-purple-500",
    border: "border-purple-500",
  },
  {
    name: "pink",
    description: "Soft and friendly",
    hex: "#ec4899",
    background: "bg-[#F3DCE1] dark:bg-[#452933] text-primary",
    fillSecondary: "fill-[#F3DCE1] dark:fill-[#452933] text-primary",
    text: "text-pink-500",
    fill: "fill-pink-500",
    border: "border-pink-500",
  },
  {
    name: "red",
    description: "Bold and urgent",
    hex: "#ef4444",
    background: "bg-[#F2DDDA] dark:bg-[#4A2623] text-primary",
    fillSecondary: "fill-[#F2DDDA] dark:fill-[#4A2623] text-primary",
    text: "text-red-500",
    fill: "fill-red-500",
    border: "border-red-500",
  },
] as const);

/** Pre-computed length avoids property access in hot path */
const PALETTE_LENGTH = COLOR_PALETTE.length;

/** Exported types for consumers */
export type ColorEntry = (typeof COLOR_PALETTE)[number];
export type ColorName = ColorEntry["name"];
export type ColorVariant = keyof ColorEntry;

/** Cache for hash lookups - avoids recalculating for same values */
const indexCache: Record<string, number> = Object.create(null);
let cacheSize = 0;
const MAX_CACHE_SIZE = 500;

/**
 * Hash a value to a consistent palette index (memoized)
 * Uses plain object cache (faster than Map for string keys)
 */
function getIndex(value: string | number): number {
  const key = String(value);
  const cached = indexCache[key];
  if (cached !== undefined) return cached;

  // Compute hash (djb2 variant)
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % PALETTE_LENGTH;

  // Cache with size limit (clear all when full - simple & effective)
  if (cacheSize >= MAX_CACHE_SIZE) {
    for (const k in indexCache) delete indexCache[k];
    cacheSize = 0;
  }
  indexCache[key] = index;
  cacheSize++;

  return index;
}

/**
 * Get color variant from palette
 */
function getFromPalette(
  value: string | number | undefined,
  variant: ColorVariant,
  fallback: string,
): string {
  if (value === undefined || value === null) return fallback;
  return COLOR_PALETTE[getIndex(value)][variant];
}

/**
 * Unified color API - deterministic hash-based colors
 * Same input always returns the same color
 *
 * @example
 * color.hex(userId)        // '#ef4444'
 * color.background(id)     // 'bg-red-500/20 dark:bg-red-500/10'
 * color.text(label)        // 'text-red-500'
 * color.fill(iconName)     // 'fill-red-500'
 * color.border(category)   // 'border-red-500'
 * color.name(id)           // 'red'
 * color.description(id)    // 'Bold and urgent'
 */
export const color = Object.freeze({
  hex: (value?: string | number) => getFromPalette(value, "hex", COLOR_PALETTE[0].hex),
  background: (value?: string | number) => getFromPalette(value, "background", "bg-secondary"),
  fillSecondary: (value?: string | number) =>
    getFromPalette(value, "fillSecondary", "fill-muted-foreground"),
  text: (value?: string | number) => getFromPalette(value, "text", "text-muted-foreground"),
  fill: (value?: string | number) => getFromPalette(value, "fill", "fill-muted-foreground"),
  border: (value?: string | number) => getFromPalette(value, "border", "border-border"),
  name: (value?: string | number) => getFromPalette(value, "name", COLOR_PALETTE[0].name),
  description: (value?: string | number) =>
    getFromPalette(value, "description", COLOR_PALETTE[0].description),
});

/** Export palette for iteration (e.g., color pickers) */
export const COLOR_PALETTE_LIST = COLOR_PALETTE;
