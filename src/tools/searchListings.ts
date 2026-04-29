import type { UserPreferences, Listing } from "../types";
import { useAppStore } from "../state";
import syntheticData from "../data/synthetic_listings.json";
import {
  fetchInterMbaListings,
  fetchCraigslistListings,
  fetchZillowListings,
  fetchAirbnbListings,
} from "./sources";

// ---------------------------------------------------------------------------
// City alias sets for loose matching
// ---------------------------------------------------------------------------
const CITY_ALIASES: Record<string, string[]> = {
  "San Francisco": ["san francisco", "sf", "bay area", "berkeley", "palo alto", "menlo park", "stanford", "california", "ca 94"],
  "New York": ["new york", "nyc", "manhattan", "brooklyn", "queens", "bronx", "ny 1"],
};

function matchesCity(address: string, prefsCity: string): boolean {
  if (!address) return true; // empty address = can't filter, keep it
  const lower = address.toLowerCase();
  const aliases = CITY_ALIASES[prefsCity] ?? [prefsCity.toLowerCase()];
  return aliases.some((alias) => lower.includes(alias));
}

// ---------------------------------------------------------------------------
// Loosened filters for real-world data
// ---------------------------------------------------------------------------
function applyLooseFilters(
  listings: Listing[],
  prefs: UserPreferences,
): Listing[] {
  const maxPrice = prefs.budget_max_usd * 1.5; // 50% headroom for real listings

  return listings.filter((l) => {
    // City — skip if address is empty (can't determine)
    if (l.address && !matchesCity(l.address, prefs.city)) return false;
    // Furnished — only enforce if listing is explicitly unfurnished
    if (prefs.furnished && l.furnished === false) return false;
    // Price — keep if 0 (unknown) or within headroom
    if (l.price_usd_per_month > 0 && l.price_usd_per_month > maxPrice) return false;
    // Dates — skip if available_from is missing or empty
    if (l.available_from && l.available_from > prefs.start_date) return false;
    if (l.available_to !== null && l.available_to && l.available_to < prefs.end_date) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Dedup by normalized address. First seen wins.
// ---------------------------------------------------------------------------
function dedup(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const result: Listing[] = [];
  for (const l of listings) {
    const key = l.address.toLowerCase().trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(l);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Synthetic data path (for demos)
// ---------------------------------------------------------------------------
function filterSynthetic(prefs: UserPreferences): Listing[] {
  const cityName = prefs.city;
  const maxPrice = prefs.budget_max_usd * 1.5; // generous for demo

  const matches = (syntheticData as Listing[]).filter((listing) => {
    if (!listing.address.includes(cityName)) return false;
    if (prefs.furnished && !listing.furnished) return false;
    if (listing.price_usd_per_month > maxPrice) return false;
    // Skip date filters for synthetic data — dates are hardcoded to 2026
    return true;
  });

  if (matches.length < 3) {
    console.warn(
      `searchListings: only ${matches.length} synthetic listings survived filtering for ${cityName}`,
    );
  }

  return matches.slice(0, 15);
}

// ---------------------------------------------------------------------------
// RentCast API path
// ---------------------------------------------------------------------------
interface RentCastProperty {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  latitude?: number;
  longitude?: number;
  bedrooms?: number;
  bathrooms?: number;
  price?: number;
  listingType?: string;
  listedDate?: string;
  status?: string;
  description?: string;
  features?: string[];
  photos?: string[];
  propertyType?: string;
  squareFootage?: number;
}

function mapRentCastToListing(rc: RentCastProperty): Listing {
  const desc = rc.description ?? "";
  const isFurnished = /furnished/i.test(desc);

  return {
    id: rc.id ?? `rc-${Math.random().toString(36).slice(2, 10)}`,
    source: "RentCast",
    title: `${rc.bedrooms ?? 0}BR at ${rc.formattedAddress ?? rc.addressLine1 ?? "Unknown"}`,
    url: `https://example.com/listing/${rc.id ?? "unknown"}`,
    price_usd_per_month: rc.price ?? 0,
    bedrooms: rc.bedrooms ?? 0,
    bathrooms: rc.bathrooms ?? 1,
    furnished: isFurnished,
    available_from:
      rc.listedDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    available_to: null,
    address:
      rc.formattedAddress ??
      `${rc.addressLine1 ?? ""}, ${rc.city ?? ""}, ${rc.state ?? ""}`,
    lat: rc.latitude ?? 0,
    lng: rc.longitude ?? 0,
    amenities: rc.features ?? [],
    description: desc || "No description provided.",
    posted_at: rc.listedDate ?? new Date().toISOString(),
  };
}

async function fetchRentCast(prefs: UserPreferences): Promise<Listing[]> {
  const { rentcastApiKey } = useAppStore.getState().settings;
  if (!rentcastApiKey) return [];

  const cityStateMap: Record<string, { city: string; state: string }> = {
    "San Francisco": { city: "San+Francisco", state: "CA" },
    "New York": { city: "New+York", state: "NY" },
  };

  const mapped = cityStateMap[prefs.city];
  if (!mapped) return [];

  try {
    const url =
      `https://api.rentcast.io/v1/listings/rental/long-term` +
      `?city=${mapped.city}&state=${mapped.state}&status=Active&limit=20`;

    const response = await fetch(url, {
      headers: { "X-Api-Key": rentcastApiKey },
    });

    if (!response.ok) {
      console.warn(`RentCast failed: HTTP ${response.status}`);
      return [];
    }

    const data: RentCastProperty[] = await response.json();
    return data.map(mapRentCastToListing);
  } catch (err) {
    console.warn("RentCast error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function searchListings(
  prefs: UserPreferences,
): Promise<Listing[]> {
  const { useSyntheticData } = useAppStore.getState().settings;

  // Synthetic-only mode for demos
  if (useSyntheticData) {
    const results = filterSynthetic(prefs);
    console.log("searchListings: using synthetic data,", results.length, "listings");
    return results;
  }

  // Fetch all real sources in parallel
  const [rentcastResult, intermbaResult, craigslistResult, zillowResult, airbnbResult] =
    await Promise.allSettled([
      fetchRentCast(prefs),
      fetchInterMbaListings(prefs),
      fetchCraigslistListings(prefs),
      fetchZillowListings(prefs),
      fetchAirbnbListings(prefs),
    ]);

  const rentcast =
    rentcastResult.status === "fulfilled" ? rentcastResult.value : [];
  const intermba =
    intermbaResult.status === "fulfilled" ? intermbaResult.value : [];
  const craigslist =
    craigslistResult.status === "fulfilled" ? craigslistResult.value : [];
  const zillow =
    zillowResult.status === "fulfilled" ? zillowResult.value : [];
  const airbnb =
    airbnbResult.status === "fulfilled" ? airbnbResult.value : [];

  if (rentcastResult.status === "rejected")
    console.warn("RentCast source failed:", rentcastResult.reason);
  if (intermbaResult.status === "rejected")
    console.warn("InterMBA source failed:", intermbaResult.reason);
  if (craigslistResult.status === "rejected")
    console.warn("Craigslist source failed:", craigslistResult.reason);
  if (zillowResult.status === "rejected")
    console.warn("Zillow source failed:", zillowResult.reason);
  if (airbnbResult.status === "rejected")
    console.warn("Airbnb source failed:", airbnbResult.reason);

  // Log RAW per-source counts BEFORE filter
  console.log("searchListings RAW counts:", {
    RentCast: rentcast.length,
    InterMBA: intermba.length,
    Craigslist: craigslist.length,
    Zillow: zillow.length,
    Airbnb: airbnb.length,
  });

  // Apply loose filters to all sources
  const filteredRentcast = applyLooseFilters(rentcast, prefs);
  const filteredIntermba = applyLooseFilters(intermba, prefs);
  const filteredCraigslist = applyLooseFilters(craigslist, prefs);
  const filteredZillow = applyLooseFilters(zillow, prefs);
  const filteredAirbnb = applyLooseFilters(airbnb, prefs);

  // Merge and dedup
  const merged = dedup([
    ...filteredRentcast,
    ...filteredIntermba,
    ...filteredCraigslist,
    ...filteredZillow,
    ...filteredAirbnb,
  ]);

  // Log FINAL per-source counts AFTER filter
  const finalCounts: Record<string, number> = {};
  for (const l of merged) {
    finalCounts[l.source] = (finalCounts[l.source] ?? 0) + 1;
  }
  console.log("searchListings FINAL counts:", finalCounts);

  if (merged.length === 0) {
    console.error(
      "All real sources returned zero listings. Check console for source-specific errors.",
    );
  }

  return merged.slice(0, 25);
}
