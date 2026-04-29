import type { UserPreferences, Listing } from "../../types";
import { useAppStore } from "../../state";

/**
 * Inside Airbnb publishes free CSV datasets for major cities.
 * The detailed listings.csv.gz has: name, listing_url, description,
 * neighbourhood, lat/lng, room_type, bedrooms, bathrooms, amenities,
 * minimum_nights, availability.
 *
 * Prices have been removed from recent scrapes, so we set price=0
 * and let the AI ranker work with other signals.
 */

const CITY_URLS: Record<string, string> = {
  "San Francisco":
    "https://data.insideairbnb.com/united-states/ca/san-francisco/2025-12-04/data/listings.csv.gz",
  "New York":
    "https://data.insideairbnb.com/united-states/ny/new-york-city/2026-02-13/data/listings.csv.gz",
};

/** Parse a CSV row respecting quoted fields. */
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

export async function fetchAirbnbListings(
  prefs: UserPreferences,
): Promise<Listing[]> {
  const { corsProxyUrl } = useAppStore.getState().settings;

  const dataUrl = CITY_URLS[prefs.city];
  if (!dataUrl) {
    console.warn(`Airbnb: no dataset URL for city "${prefs.city}"`);
    return [];
  }

  try {
    // The CSV is gzipped — fetch through CORS proxy since it's cross-origin.
    // The browser will auto-decompress if the server sends Content-Encoding: gzip.
    // allorigins proxy returns raw bytes, so we try both approaches.
    const fetchUrl = corsProxyUrl
      ? corsProxyUrl + encodeURIComponent(dataUrl)
      : dataUrl;

    const res = await fetch(fetchUrl);
    if (!res.ok) {
      console.warn(`Airbnb: fetch failed HTTP ${res.status}`);
      return [];
    }

    // Try to decompress — the response might be gzipped bytes
    let text: string;
    try {
      const blob = await res.blob();
      const ds = new DecompressionStream("gzip");
      const decompressed = blob.stream().pipeThrough(ds);
      text = await new Response(decompressed).text();
    } catch {
      // If decompression fails, maybe proxy already decompressed it
      text = await res.clone().text();
    }

    const lines = text.split("\n");
    if (lines.length < 2) {
      console.warn("Airbnb: CSV is empty");
      return [];
    }

    // Parse header
    const headers = parseRow(lines[0]);
    const col = (name: string) => headers.indexOf(name);

    const iName = col("name");
    const iUrl = col("listing_url");
    const iDesc = col("description");
    const iNeighbourhood = col("neighbourhood_cleansed");
    const iLat = col("latitude");
    const iLng = col("longitude");
    const iRoomType = col("room_type");
    const iBedrooms = col("bedrooms");
    const iBathrooms = col("bathrooms_text");
    const iAmenities = col("amenities");
    const iMinNights = col("minimum_nights");
    const iAvail365 = col("availability_365");
    const iPrice = col("price");

    const listings: Listing[] = [];

    // Parse rows — limit to 500 to keep it fast, then filter down
    const maxScan = Math.min(lines.length, 2000);
    for (let i = 1; i < maxScan; i++) {
      if (!lines[i].trim()) continue;
      const row = parseRow(lines[i]);

      const roomType = row[iRoomType] ?? "";
      // Only keep entire homes/apts — skip shared rooms and hotel rooms
      if (!roomType.toLowerCase().includes("entire")) continue;

      const minNights = parseInt(row[iMinNights] ?? "0", 10);
      // Skip listings that require stays > 90 nights (not sublet-friendly)
      if (minNights > 90) continue;

      const avail = parseInt(row[iAvail365] ?? "0", 10);
      // Skip unavailable listings
      if (avail === 0) continue;

      // Parse price — format is "$1,234.00" or empty
      const priceRaw = (row[iPrice] ?? "").replace(/[$,]/g, "");
      const pricePerNight = parseFloat(priceRaw) || 0;
      // Convert nightly to monthly estimate (30 nights)
      const pricePerMonth = pricePerNight > 0 ? Math.round(pricePerNight * 30) : 0;

      const name = row[iName] ?? "Airbnb listing";
      const neighbourhood = row[iNeighbourhood] ?? "";
      const bedrooms = parseInt(row[iBedrooms] ?? "1", 10) || 1;

      // Parse amenities from JSON array string like '["Wifi", "Kitchen"]'
      let amenities: string[] = [];
      try {
        const raw = row[iAmenities] ?? "[]";
        amenities = JSON.parse(raw.replace(/'/g, '"'));
      } catch {
        // ignore parse errors
      }

      const cityName = prefs.city === "San Francisco" ? "San Francisco, CA" : "New York, NY";

      const listing: Listing = {
        id: `airbnb-${row[0] ?? i}`,
        source: "Airbnb",
        title: name,
        url: row[iUrl] ?? `https://www.airbnb.com/rooms/${row[0] ?? ""}`,
        price_usd_per_month: pricePerMonth,
        bedrooms,
        bathrooms: parseInt(row[iBathrooms] ?? "1", 10) || 1,
        furnished: true, // Airbnb listings are furnished
        available_from: "", // not available in dataset
        available_to: null,
        address: `${neighbourhood}, ${cityName}`,
        lat: parseFloat(row[iLat] ?? "0") || 0,
        lng: parseFloat(row[iLng] ?? "0") || 0,
        amenities: amenities
          .map((a) => a.toLowerCase().replace(/\s+/g, "_"))
          .slice(0, 10),
        description:
          (row[iDesc] ?? "").slice(0, 500) || "Listed on Airbnb.",
        posted_at: new Date().toISOString(),
      };

      listings.push(listing);
      if (listings.length >= 15) break;
    }

    console.log(
      `Airbnb[${prefs.city}]: scanned ${Math.min(maxScan, lines.length)} rows, returning ${listings.length} listings` +
        (listings.length > 0
          ? ` (price available: ${listings.filter((l) => l.price_usd_per_month > 0).length})`
          : ""),
    );

    return listings;
  } catch (err) {
    console.warn("Airbnb fetch error:", err);
    return [];
  }
}
