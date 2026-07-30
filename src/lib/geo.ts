// Great-circle geometry. One implementation, because two copies of a formula
// drift and this one decides both whether a vessel moved and whether two
// vessels share a weather system.
//
// Pure.

const EARTH_RADIUS_M = 6_371_000;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great-circle distance in metres. Correct across the antimeridian. */
export function haversineMetres(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // Clamp before asin: floating error can push the argument marginally above 1
  // for antipodal points, which would return NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function haversineKm(a: LatLon, b: LatLon): number {
  return haversineMetres(a, b) / 1000;
}
