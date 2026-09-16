import type { FeatureCollection, Point } from "geojson";
import type { AddLayerObject } from "maplibre-gl";
import type { ExploreCategory, Place } from "../../lib/phase5/contract";

/**
 * The exact paint value type MapLibre accepts for a circle's colour.
 *
 * Derived from the library rather than hand-written, so a data-driven expression
 * is checked against the real style spec instead of being silenced with a cast.
 */
type CircleColorPaint = NonNullable<Extract<AddLayerObject, { type: "circle" }>["paint"]>["circle-color"];

/**
 * Explore map visual language.
 *
 * The reference is Bump's *mechanics* — people and places on one friendly map,
 * large expressive markers, clustered social information, bottom-sheet detail —
 * not its assets. The palette stays inside the existing YapYep monochrome system
 * (ADR-003) with cobalt as the single accent, so a marker reads as part of the
 * product rather than as a third-party map plugin.
 *
 * Four marker kinds, and the distinction is real data, not decoration:
 *   standard     an OSM place
 *   recommended  a student wrote about it (studentStories > 0)
 *   anchor       a curated, reviewed anchor from the seed pack
 *   saved        the viewer bookmarked it
 */

export type MarkerKind = "standard" | "recommended" | "anchor" | "saved";

export const MAP_COLORS = {
  ink: "#111111",
  cobalt: "#3157D5",
  white: "#FFFFFF",
  halo: "#3157D5",
  anchor: "#1F7A5C",
  saved: "#8A4B10",
  clusterText: "#111111",
} as const;

/**
 * Basemap style. Configurable on purpose: OpenFreeMap is a free public instance
 * with no SLA and no API key, so a demo must be able to point elsewhere without a
 * code change. `positron` is the calm monochrome base the markers are designed
 * against.
 */
export const MAP_STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || "https://tiles.openfreemap.org/styles/positron";

export const MAP_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> contributors';

/** Single-character category glyphs — letters, not emoji (ADR-003 §4). */
export const CATEGORY_GLYPH: Record<string, string> = {
  campus: "C",
  study: "S",
  food: "F",
  coffee: "K",
  health: "H",
  pharmacy: "P",
  banking: "B",
  transport: "T",
  culture: "A",
  religion: "R",
  hangout: "G",
  studentlife: "L",
  all: "•",
};

export function glyphFor(category: string): string {
  return CATEGORY_GLYPH[category] ?? "•";
}

export function markerKindFor(place: Place, savedIds: Set<string>): MarkerKind {
  if (savedIds.has(place.id)) return "saved";
  if (place.source === "seed_pack_researched") return "anchor";
  if (place.studentStories > 0) return "recommended";
  return "standard";
}

export interface PlaceFeatureProperties {
  id: string;
  name: string;
  category: string;
  glyph: string;
  markerKind: MarkerKind;
  stories: number;
  saves: number;
  isAnchor: boolean;
}

/** Build the GeoJSON the map source consumes. Coordinates are [lng, lat]. */
export function toFeatureCollection(
  places: Place[],
  savedIds: Set<string>,
): FeatureCollection<Point, PlaceFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: places
      .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng))
      .map((place) => {
        const markerKind = markerKindFor(place, savedIds);
        return {
          type: "Feature" as const,
          id: hashId(place.id),
          geometry: { type: "Point" as const, coordinates: [place.lng, place.lat] as [number, number] },
          properties: {
            id: place.id,
            name: place.name,
            category: place.category,
            glyph: glyphFor(place.category),
            markerKind,
            stories: place.studentStories,
            saves: place.studentSaves,
            isAnchor: place.source === "seed_pack_researched",
          } satisfies PlaceFeatureProperties,
        };
      }),
  };
}

/**
 * MapLibre feature ids must be numbers. Hashing the place id keeps the mapping
 * stable so a re-render does not shuffle which pin is which.
 */
function hashId(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash % 2147483647;
}

/** Colour expression shared by the halo and the dot so they can never diverge. */
export const MARKER_COLOR_EXPRESSION: CircleColorPaint = [
  "match",
  ["get", "markerKind"],
  "saved",
  MAP_COLORS.saved,
  "anchor",
  MAP_COLORS.anchor,
  "recommended",
  MAP_COLORS.cobalt,
  MAP_COLORS.ink,
];

export const CATEGORY_ORDER: ExploreCategory[] = [
  "all",
  "campus",
  "study",
  "food",
  "coffee",
  "health",
  "pharmacy",
  "banking",
  "transport",
  "culture",
  "religion",
  "hangout",
  "studentlife",
];
