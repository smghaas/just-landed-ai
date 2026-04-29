import type { UserPreferences, Listing } from "../../types";
import { useAppStore } from "../../state";

const CRAIGSLIST_DOMAINS: Record<string, string> = {
  "San Francisco": "sfbay.craigslist.org",
  "New York": "newyork.craigslist.org",
};

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export async function fetchCraigslistListings(
  prefs: UserPreferences,
): Promise<Listing[]> {
  const { corsProxyUrl } = useAppStore.getState().settings;
  const domain = CRAIGSLIST_DOMAINS[prefs.city];
  if (!domain) return [];

  const rssUrl = `https://${domain}/search/sub?format=rss&is_furnished=1`;
  const fetchUrl = corsProxyUrl
    ? corsProxyUrl + encodeURIComponent(rssUrl)
    : rssUrl;

  let xmlText: string;
  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) {
      console.warn(`Craigslist fetch failed: HTTP ${res.status}`);
      return [];
    }
    xmlText = await res.text();
  } catch (err) {
    console.warn("Craigslist fetch error:", err);
    return [];
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const items = doc.querySelectorAll("item");
  const maxPrice = prefs.budget_max_usd * 1.1;

  const listings: Listing[] = [];

  items.forEach((item) => {
    if (listings.length >= 10) return;

    const title = item.querySelector("title")?.textContent ?? "";
    const link = item.querySelector("link")?.textContent ?? "";
    const description = item.querySelector("description")?.textContent ?? "";
    const pubDate = item.querySelector("pubDate")?.textContent ?? "";

    // Extract price from title: "$2,400"
    const priceMatch = title.match(/\$([\d,]+)/);
    const price = priceMatch
      ? parseInt(priceMatch[1].replace(/,/g, ""), 10)
      : 0;

    if (price > 0 && price > maxPrice) return;

    // Try to extract bedrooms
    const brMatch = title.match(/(\d+)\s?(?:br|bed)/i);
    const bedrooms = brMatch ? parseInt(brMatch[1], 10) : 1;

    const listing: Listing = {
      id: `craigslist-${hashString(link || title)}`,
      source: "Craigslist",
      title: title || "Craigslist sublet",
      url: link,
      price_usd_per_month: price,
      bedrooms,
      bathrooms: 1,
      furnished: true, // filtered by is_furnished=1
      available_from: pubDate
        ? new Date(pubDate).toISOString().slice(0, 10)
        : prefs.start_date,
      available_to: null,
      address: title, // best available without geocoding
      lat: 0,
      lng: 0,
      amenities: [],
      description:
        description.replace(/<[^>]*>/g, "").slice(0, 500) ||
        "Listed on Craigslist.",
      posted_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    };

    listings.push(listing);
  });

  return listings;
}
