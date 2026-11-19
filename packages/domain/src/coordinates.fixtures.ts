/**
 * Kakao map coordinates (WCONGNAMUL) with the latitude/longitude the Kakao Maps SDK gives for
 * them: `new kakao.maps.Coords(x, y).toLatLng()` on map.kakao.com. Filled in by the owner
 * (Seoul, Busan, Jeju); empty until then, so the matching test is skipped.
 */
export interface CoordinateFixture {
  place: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
}

export const OWNER_FIXTURES: readonly CoordinateFixture[] = [];
