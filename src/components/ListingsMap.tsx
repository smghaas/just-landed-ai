import { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Listing, RankedListing } from "../types";

// Fix default marker icon paths broken by bundlers
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface ListingsMapProps {
  listings: Listing[];
  rankedListings: RankedListing[];
  onSelectListing?: (id: string) => void;
}

function fitScoreStyle(score: number): { color: string; label: string } {
  if (score >= 80) return { color: "#16a34a", label: "green" };
  if (score >= 60) return { color: "#d97706", label: "amber" };
  return { color: "#dc2626", label: "red" };
}

function formatPrice(price: number): string {
  if (price === 0) return "Price on request";
  return `$${price.toLocaleString()}/mo`;
}

export default function ListingsMap({
  listings,
  rankedListings,
  onSelectListing,
}: ListingsMapProps) {
  const rankedMap = useMemo(
    () => new Map(rankedListings.map((r) => [r.listing_id, r])),
    [rankedListings],
  );

  const geoListings = useMemo(
    () => listings.filter((l) => l.lat !== 0 && l.lng !== 0),
    [listings],
  );

  // Compute center from listings, fallback to SF
  const center = useMemo<[number, number]>(() => {
    if (geoListings.length === 0) return [37.7749, -122.4194];
    const avgLat =
      geoListings.reduce((s, l) => s + l.lat, 0) / geoListings.length;
    const avgLng =
      geoListings.reduce((s, l) => s + l.lng, 0) / geoListings.length;
    return [avgLat, avgLng];
  }, [geoListings]);

  if (geoListings.length === 0) return null;

  return (
    <div className="rounded-lg overflow-hidden border border-gray-200 shadow-sm">
      <MapContainer
        center={center}
        zoom={12}
        scrollWheelZoom={true}
        style={{ height: 400, width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {geoListings.map((listing) => {
          const ranked = rankedMap.get(listing.id);
          const score = ranked?.fit_score ?? 0;
          const { color } = fitScoreStyle(score);

          return (
            <Marker key={listing.id} position={[listing.lat, listing.lng]}>
              <Popup>
                <div style={{ minWidth: 180 }}>
                  <strong style={{ fontSize: 14 }}>{listing.title}</strong>
                  <br />
                  <span style={{ fontSize: 13 }}>
                    {formatPrice(listing.price_usd_per_month)}
                  </span>
                  <br />
                  {ranked && (
                    <span
                      style={{
                        display: "inline-block",
                        marginTop: 4,
                        padding: "2px 8px",
                        borderRadius: 12,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#fff",
                        backgroundColor: color,
                      }}
                    >
                      {score}% fit
                    </span>
                  )}
                  {onSelectListing && (
                    <>
                      <br />
                      <button
                        onClick={() => onSelectListing(listing.id)}
                        style={{
                          marginTop: 6,
                          fontSize: 12,
                          color: "#2563eb",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          textDecoration: "underline",
                        }}
                      >
                        View details
                      </button>
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
