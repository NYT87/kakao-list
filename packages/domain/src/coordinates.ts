import proj4 from "proj4";

/**
 * Kakao map coordinates (WCONGNAMUL) are EPSG:5181 (Korea 2000 / Central Belt, GRS80, no datum
 * shift) scaled by 2.5.
 */
const EPSG_5181 =
  "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs";
const toWgs84 = proj4(EPSG_5181, "WGS84");

const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Latitude/longitude for a Kakao map point, or undefined when the input isn't a usable point or
 * lands outside Korea (32–40°N, 123–133°E). Never throws: callers read stored snapshots with it.
 */
export function wcongnamulToLatLng(
  x: unknown,
  y: unknown,
): { lat: number; lng: number } | undefined {
  if (!positive(x) || !positive(y)) return undefined;
  const [lng, lat] = toWgs84.forward([x / 2.5, y / 2.5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < 32 || lat > 40 || lng < 123 || lng > 133) return undefined;
  return { lat, lng };
}
