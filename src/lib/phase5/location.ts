import { useCallback, useEffect, useRef, useState } from "react";
import type { LocationPermission } from "./contract";

/**
 * Browser geolocation, wrapped so the UI can render every state honestly.
 *
 * The rules this enforces:
 *  - The prompt is never raised on mount. A student opening Explore has not asked
 *    to be located, and a permission dialog they did not request is the fastest
 *    way to get a permanent "denied" from a nervous user.
 *  - A denied or unavailable browser still gets a fully working map, centred on
 *    the host campus instead of on the student.
 *  - The position is held in memory for the session only. It is never written to
 *    Appwrite, so "we do not store your live location" stays true by construction.
 */

export interface LocationState {
  permission: LocationPermission;
  position: { lat: number; lng: number } | null;
  error: string | null;
  request: () => void;
}

export function useLocationPermission(): LocationState {
  const [permission, setPermission] = useState<LocationPermission>(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return "unavailable";
    // A modern browser exposes the current decision without prompting. When it
    // does not, "not_requested" is the honest answer, not "denied".
    return "not_requested";
  });
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Read the existing decision where the Permissions API allows it, so a student
  // who already said no sees "Location off" instead of a button that will fail.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        if (cancelled || !mounted.current) return;
        if (status.state === "granted") setPermission("granted");
        else if (status.state === "denied") setPermission("denied");
      })
      .catch(() => {
        // Safari and older browsers reject this query; not an error worth showing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setPermission("unavailable");
      setError("This browser cannot share a location.");
      return;
    }
    setPermission("requesting");
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (result) => {
        if (!mounted.current) return;
        setPermission("granted");
        setPosition({ lat: result.coords.latitude, lng: result.coords.longitude });
      },
      (failure) => {
        if (!mounted.current) return;
        // PERMISSION_DENIED is the student's choice, not a fault; the message says so.
        setPermission(failure.code === failure.PERMISSION_DENIED ? "denied" : "unavailable");
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? "Location is off. The map is centred on your university instead."
            : "We could not get a location right now. The map still works.",
        );
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, []);

  return { permission, position, error, request };
}

export function permissionLabel(permission: LocationPermission): string {
  switch (permission) {
    case "granted":
      return "Showing distances from you";
    case "requesting":
      return "Getting your location…";
    case "denied":
      return "Location off";
    case "unavailable":
      return "Location unavailable";
    default:
      return "Distances from campus";
  }
}

/** `prefers-reduced-motion`, read live so a mid-session change is respected. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);
  return reduced;
}
