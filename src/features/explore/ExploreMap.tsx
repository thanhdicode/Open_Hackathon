import { useEffect, useMemo, useRef, useState } from "react";
import {
  AttributionControl,
  GeoJSONSource,
  Map as MapLibreMap,
  NavigationControl,
  type MapMouseEvent,
} from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { configureMapWorker } from "./map-worker";
import { Icon } from "../../components/icons";
import type { Place } from "../../lib/phase5/contract";
import { Button } from "../../components/ui";
import {
  MAP_ATTRIBUTION,
  MAP_COLORS,
  MAP_STYLE_URL,
  MARKER_COLOR_EXPRESSION,
  toFeatureCollection,
  type PlaceFeatureProperties,
} from "./map-style";

/**
 * The Explore map.
 *
 * This replaces a hand-drawn SVG grid that had no relationship to geography —
 * pins sat at hand-picked percentages, so "5 min away" was a number typed into a
 * file rather than a distance. Everything here comes from the `places` table,
 * which is itself OSM data, so a pin's position is the place's real position.
 *
 * Performance shape: ONE GeoJSON source with server-side clustering and a handful
 * of layers. Adding ~1,000 React DOM markers would stall the main thread on every
 * pan; MapLibre draws these on the GPU and clusters them for us.
 *
 * Failure shape: if the basemap style cannot load, the map area says so and the
 * list below it keeps working. A dead tile server must not become a white screen.
 */

export interface ExploreMapProps {
  places: Place[];
  savedIds: Set<string>;
  selectedId: string | null;
  center: { lat: number; lng: number };
  onSelect: (place: Place) => void;
  onClearSelection: () => void;
  /** Null until the student answers the location prompt. */
  userLocation: { lat: number; lng: number } | null;
  reducedMotion: boolean;
}

const SOURCE_ID = "yapyep-places";

export function ExploreMap({
  places,
  savedIds,
  selectedId,
  center,
  onSelect,
  onClearSelection,
  userLocation,
  reducedMotion,
}: ExploreMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [styleState, setStyleState] = useState<"loading" | "ready" | "error">("loading");
  const [expandedCluster, setExpandedCluster] = useState<{ count: number; lng: number; lat: number } | null>(null);
  /** Read inside MapLibre event handlers, which are registered once. */
  const placesRef = useRef(places);
  placesRef.current = places;

  const featureCollection = useMemo(() => toFeatureCollection(places, savedIds), [places, savedIds]);

  /* ------------------------------ map lifecycle ----------------------------- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Clustering depends on the worker, so it must be wired before the map exists.
    configureMapWorker();

    const map = new MapLibreMap({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [center.lng, center.lat],
      zoom: 14.2,
      attributionControl: false,
      // The student's own position is opt-in and is never written anywhere, so it
      // is drawn by us rather than tracked by the basemap.
      trackResize: true,
    });
    mapRef.current = map;

    map.addControl(new AttributionControl({ compact: true, customAttribution: MAP_ATTRIBUTION }), "bottom-right");
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    map.on("error", (event) => {
      // Tile-level errors are constant and ignorable; a style failure is not.
      const message = String((event as { error?: { message?: string } }).error?.message ?? "");
      if (message.includes("style") || message.includes("Failed to fetch")) setStyleState("error");
    });

    map.on("load", () => {
      setStyleState("ready");

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: toFeatureCollection(placesRef.current, new Set()),
        cluster: true,
        clusterRadius: 54,
        clusterMaxZoom: 15,
      });

      // --- clusters ---------------------------------------------------------
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": MAP_COLORS.ink,
          "circle-opacity": 0.92,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 17, 20, 24, 100, 31, 500, 38],
          "circle-stroke-width": 3,
          "circle-stroke-color": MAP_COLORS.white,
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
        },
        paint: { "text-color": MAP_COLORS.white },
      });

      // --- individual places ------------------------------------------------
      // A soft halo, then the dot, then the category glyph: the halo is what
      // makes a cluster of pins legible over a busy basemap without a hard shadow.
      map.addLayer({
        id: "place-halo",
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": MARKER_COLOR_EXPRESSION,
          "circle-opacity": 0.16,
          "circle-radius": 20,
        },
      });
      map.addLayer({
        id: "place-dot",
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": MARKER_COLOR_EXPRESSION,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 15, 11, 18, 13],
          "circle-stroke-width": 2.5,
          "circle-stroke-color": MAP_COLORS.white,
        },
      });
      map.addLayer({
        id: "place-glyph",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["get", "glyph"],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 16, 11],
          "text-allow-overlap": true,
        },
        paint: { "text-color": MAP_COLORS.white },
      });
      // A name label appears only once the pins are far enough apart to read.
      map.addLayer({
        id: "place-label",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        minzoom: 15.4,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
          "text-max-width": 9,
        },
        paint: {
          "text-color": MAP_COLORS.ink,
          "text-halo-color": MAP_COLORS.white,
          "text-halo-width": 1.6,
        },
      });

      map.on("click", "clusters", async (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ["clusters"] })[0];
        if (!feature) return;
        const clusterId = feature.properties?.cluster_id as number;
        const source = map.getSource(SOURCE_ID) as GeoJSONSource;
        try {
          const zoom = await source.getClusterExpansionZoom(clusterId);
          const [lng, lat] = (feature.geometry as Point).coordinates;
          map.easeTo({ center: [lng, lat], zoom: Math.min(zoom + 0.4, 18), duration: reducedMotion ? 0 : 520 });
          setExpandedCluster({ count: feature.properties?.point_count ?? 0, lng, lat });
        } catch {
          // A cluster that cannot expand is not worth an error state.
        }
      });

      map.on("click", "place-dot", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const properties = feature.properties as unknown as PlaceFeatureProperties;
        const place = placesRef.current.find((candidate) => candidate.id === properties.id);
        if (place) onSelect(place);
      });

      // An empty click clears the selection — the standard map gesture.
      map.on("click", (event) => {
        const hits = map.queryRenderedFeatures(event.point, { layers: ["clusters", "place-dot"] });
        if (!hits.length) onClearSelection();
      });

      for (const layer of ["clusters", "place-dot"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; everything else updates through effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------- data + centre updates -------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleState !== "ready") return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(featureCollection);
  }, [featureCollection, styleState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleState !== "ready") return;
    map.easeTo({ center: [center.lng, center.lat], zoom: 14.2, duration: reducedMotion ? 0 : 650 });
  }, [center.lat, center.lng, reducedMotion, styleState]);

  /* ------------------------------ selection --------------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleState !== "ready") return;
    if (!selectedId) return;
    const place = placesRef.current.find((candidate) => candidate.id === selectedId);
    if (!place) return;
    map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 16), duration: reducedMotion ? 0 : 520 });
  }, [selectedId, reducedMotion, styleState]);

  /* ---------------------------- user position dot ---------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleState !== "ready") return;

    const id = "yapyep-user-location";
    if (!userLocation) {
      if (map.getLayer(`${id}-dot`)) map.removeLayer(`${id}-dot`);
      if (map.getLayer(`${id}-halo`)) map.removeLayer(`${id}-halo`);
      if (map.getSource(id)) map.removeSource(id);
      return;
    }

    const data: FeatureCollection<Point> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [userLocation.lng, userLocation.lat] },
          properties: {},
        },
      ],
    };

    if (map.getSource(id)) {
      (map.getSource(id) as GeoJSONSource).setData(data);
      return;
    }
    map.addSource(id, { type: "geojson", data });
    map.addLayer({
      id: `${id}-halo`,
      type: "circle",
      source: id,
      paint: { "circle-color": MAP_COLORS.cobalt, "circle-opacity": 0.18, "circle-radius": 22 },
    });
    map.addLayer({
      id: `${id}-dot`,
      type: "circle",
      source: id,
      paint: { "circle-color": MAP_COLORS.cobalt, "circle-radius": 7, "circle-stroke-width": 3, "circle-stroke-color": MAP_COLORS.white },
    });
  }, [userLocation, styleState]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <div ref={containerRef} data-testid="explore-map" className="h-full w-full" aria-label="Map of student places" role="application" />

      {styleState === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/70">
          <p className="text-[12px] font-semibold text-muted">Loading map…</p>
        </div>
      )}

      {styleState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas px-8 text-center">
          <Icon name="map" size={26} />
          <p className="text-[14px] font-bold text-ink">The map could not load</p>
          <p className="text-[12px] text-muted">Places are still listed below, and you can open any of them.</p>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      )}

      {expandedCluster && styleState === "ready" && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-line bg-surface/95 px-3 py-1.5 text-[11px] font-semibold text-ink shadow-pop backdrop-blur">
          {expandedCluster.count} places here
          <button onClick={() => setExpandedCluster(null)} className="ml-2 text-muted" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {/*
        Attribution is required by the ODbL licence the basemap is published under
        and is rendered by the AttributionControl above. This second, always-visible
        line exists because the control collapses to an "i" on narrow screens, and a
        hidden attribution is not an attribution.
      */}
      <p className="pointer-events-none absolute bottom-0 left-0 z-10 max-w-[70%] truncate px-2 py-1 text-[9px] text-muted">
        © OpenStreetMap contributors · OpenFreeMap
      </p>
    </div>
  );
}
