/**
 * MapLibre worker wiring.
 *
 * Clustering, GeoJSON parsing and `getClusterExpansionZoom` all run in MapLibre's
 * web worker, not on the main thread. The library resolves its worker from a path
 * relative to its own bundle, which Vite's dependency pre-bundling rewrites — so
 * the request 404s and the map silently loses clustering while still drawing tiles.
 * That failure is invisible on screen, which is exactly why it is fixed explicitly
 * here instead of being left to the default.
 *
 * `?worker&url` makes Vite emit the worker as its own asset and hand back a URL
 * that is actually served, in both dev and production.
 */
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

let configured = false;

/** Point MapLibre at the bundled worker. Idempotent and safe to call repeatedly. */
export function configureMapWorker(): void {
  if (configured) return;
  setWorkerUrl(workerUrl);
  configured = true;
}
