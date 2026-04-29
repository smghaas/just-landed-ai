import type { UserPreferences, Listing } from "../../types";
import { useAppStore } from "../../state";
import syntheticData from "../../data/synthetic_listings.json";

interface ZillowApiResult {
  zpid?: number;
  address?: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  latitude?: number;
  longitude?: number;
  imgSrc?: string;
  detailUrl?: string;
  statusText?: string;
  listingSubType?: { is_furnished?: boolean };
  hdpData?: {
    homeInfo?: {
      price?: number;
      bedrooms?: number;
      bathrooms?: number;
      latitude?: number;
      longitude?: number;
      streetAddress?: string;
      city?: string;
      state?: string;
      zipcode?: string;
    };
  };
}

interface ZillowApiResponse {
  props?: ZillowApiResult[];
  results?: ZillowApiResult[];
}

export async function fetchZillowListings(
  prefs: UserPreferences,
): Promise<Listing[]> {
  const { rapidApiZillowKey, corsProxyUrl } = useAppStore.getState().settings;

  if (!rapidApiZillowKey) {
    console.warn("Zillow: no RapidAPI key set, using synthetic fallback.");
    return (syntheticData as Listing[])
      .filter((l) => l.address.includes(prefs.city))
      .slice(0, 6)
      .map((l) => ({
        ...l,
        id: `zillow-fallback-${l.id}`,
        source: "Zillow" as const,
      }));
  }

  try {
    const locationParam = encodeURIComponent(
      prefs.city === "San Francisco"
        ? "San Francisco, CA"
        : "New York, NY",
    );
    const apiUrl =
      `https://zillow-com1.p.rapidapi.com/propertyExtendedSearch?location=${locationParam}&status_type=ForRent`;

    // Try direct first, fall back to CORS proxy
    let res: Response;
    try {
      res = await fetch(apiUrl, {
        headers: {
          "X-RapidAPI-Key": rapidApiZillowKey,
          "X-RapidAPI-Host": "zillow-com1.p.rapidapi.com",
        },
      });
    } catch (directErr) {
      // Direct call likely blocked by CORS — try via proxy
      if (corsProxyUrl) {
        console.warn("Zillow: direct fetch failed (likely CORS), trying proxy...", directErr);
        res = await fetch(corsProxyUrl + encodeURIComponent(apiUrl), {
          headers: {
            "X-RapidAPI-Key": rapidApiZillowKey,
            "X-RapidAPI-Host": "zillow-com1.p.rapidapi.com",
          },
        });
      } else {
        throw directErr;
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Zillow API failed: HTTP ${res.status}`, body.slice(0, 300));
      return [];
    }

    const data: ZillowApiResponse = await res.json();
    const results = data.props ?? data.results ?? [];
    console.log(`Zillow: got ${results.length} results from API`);

    if (results.length === 0) {
      console.warn("Zillow: API returned 0 results. Response keys:", Object.keys(data));
    }

    return results.slice(0, 15).map((r, i): Listing => {
      const info = r.hdpData?.homeInfo;
      const desc = r.statusText ?? "";
      return {
        id: `zillow-${r.zpid ?? i}`,
        source: "Zillow",
        title: `${info?.bedrooms ?? r.bedrooms ?? 0}BR at ${info?.streetAddress ?? r.address ?? "Unknown"}`,
        url: r.detailUrl
          ? `https://www.zillow.com${r.detailUrl}`
          : `https://www.zillow.com/homedetails/${r.zpid ?? ""}`,
        price_usd_per_month: info?.price ?? r.price ?? 0,
        bedrooms: info?.bedrooms ?? r.bedrooms ?? 0,
        bathrooms: info?.bathrooms ?? r.bathrooms ?? 1,
        furnished: r.listingSubType?.is_furnished ?? /furnished/i.test(desc),
        available_from: prefs.start_date,
        available_to: null,
        address:
          r.address ??
          [info?.streetAddress, info?.city, info?.state, info?.zipcode]
            .filter(Boolean)
            .join(", "),
        lat: info?.latitude ?? r.latitude ?? 0,
        lng: info?.longitude ?? r.longitude ?? 0,
        amenities: [],
        description: desc || "Listed on Zillow.",
        posted_at: new Date().toISOString(),
      };
    });
  } catch (err) {
    console.error("Zillow API error:", err);
    return [];
  }
}
