import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  UserPreferences,
  Listing,
  RankedListing,
  CommuteResult,
} from "../types";
import { useAppStore } from "../state";
import { searchListings } from "../tools/searchListings";
import { getCommute } from "../tools/getCommute";
import { SYSTEM_PROMPT } from "./systemPrompt";

/**
 * Fallback ranking when Gemini is unavailable.
 * Scores listings using simple heuristics: price fit, commute, amenity matches.
 */
function fallbackRank(
  listings: Listing[],
  commuteResults: Map<string, CommuteResult>,
  prefs: UserPreferences,
): RankedListing[] {
  const scored = listings.map((listing) => {
    const commute = commuteResults.get(listing.id);
    const commuteMin = commute?.duration_min ?? 25;
    const commuteRoute = commute?.route_summary ?? "estimated";

    let score = 70; // base score

    // Price fit: closer to budget = better (skip if price unknown)
    if (listing.price_usd_per_month > 0) {
      const ratio = listing.price_usd_per_month / prefs.budget_max_usd;
      if (ratio <= 0.8) score += 15;
      else if (ratio <= 1.0) score += 10;
      else if (ratio <= 1.1) score += 5;
      else score -= 10;
    }

    // Commute: shorter = better
    if (commuteMin <= prefs.commute_max_min * 0.5) score += 10;
    else if (commuteMin <= prefs.commute_max_min) score += 5;
    else score -= 15;

    // Amenity matches
    const matched = prefs.requirements.filter((r) =>
      listing.amenities.some((a) => a.includes(r) || r.includes(a)),
    );
    score += matched.length * 3;

    // Cap at 0-100
    score = Math.max(0, Math.min(100, score));

    // Binding constraint
    let binding: string | null = null;
    if (listing.price_usd_per_month > prefs.budget_max_usd * 1.1)
      binding = "Over budget";
    else if (commuteMin > prefs.commute_max_min)
      binding = "Commute too long";

    const rationale =
      listing.price_usd_per_month > 0
        ? `$${listing.price_usd_per_month.toLocaleString()}/mo, ~${commuteMin} min commute, ${listing.bedrooms} bed`
        : `~${commuteMin} min commute, ${listing.bedrooms} bed, ${listing.source}`;

    return {
      listing_id: listing.id,
      fit_score: score,
      binding_constraint: binding,
      rationale_one_liner: rationale,
      commute_min: commuteMin,
      commute_route: commuteRoute,
    };
  });

  return scored.sort((a, b) => b.fit_score - a.fit_score).slice(0, 5);
}

export class GeminiAgent {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(
    apiKey: string,
    model: "gemini-2.5-flash" | "gemini-2.5-pro",
  ) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = model;
  }

  private log(direction: "user_to_llm" | "llm_to_user", text: string) {
    const store = useAppStore.getState();
    if (direction === "user_to_llm") {
      store.appendUserToLLM(text);
    } else {
      store.appendLLMToUser(text);
    }
  }

  private async call(userPrompt: string, systemPrompt?: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemPrompt ?? SYSTEM_PROMPT,
    });
    this.log("user_to_llm", userPrompt);
    const result = await model.generateContent(userPrompt);
    const text = result.response.text();
    this.log("llm_to_user", text);
    return text;
  }

  private parseRankedJSON(raw: string): RankedListing[] {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    }
    return JSON.parse(cleaned) as RankedListing[];
  }

  async runSearchAndRank(
    prefs: UserPreferences,
  ): Promise<{ listings: Listing[]; ranked: RankedListing[] }> {
    // 1. Search listings
    const allListings = await searchListings(prefs);

    // 2. Compute commutes in parallel
    const commuteResults: Map<string, CommuteResult> = new Map();
    const commutePromises = allListings.map(async (listing) => {
      const result = await getCommute(listing.address, prefs.office_address);
      commuteResults.set(listing.id, result);
    });
    await Promise.all(commutePromises);

    // 3. Drop listings that exceed commute max
    const surviving = allListings.filter((listing) => {
      const commute = commuteResults.get(listing.id);
      return commute ? commute.duration_min <= prefs.commute_max_min : true;
    });

    // 4. Build payload for Gemini
    const listingsWithCommute = surviving.map((listing) => ({
      ...listing,
      commute: commuteResults.get(listing.id) ?? null,
    }));

    const userPrompt = [
      "User preferences:",
      JSON.stringify(prefs, null, 2),
      "",
      `${surviving.length} listings survived filters (commute ≤ ${prefs.commute_max_min} min):`,
      JSON.stringify(listingsWithCommute, null, 2),
      "",
      "Rank the top 3–5 listings. Return ONLY a JSON array of RankedListing objects.",
    ].join("\n");

    // 5. Try Gemini, fall back to local scoring if it fails
    let ranked: RankedListing[];
    try {
      let responseText = await this.call(userPrompt);

      // 6. Parse — retry once if invalid
      try {
        ranked = this.parseRankedJSON(responseText);
      } catch {
        const retryPrompt =
          responseText +
          "\n\nRespond ONLY with valid JSON matching the RankedListing[] schema. No prose, no markdown.";
        responseText = await this.call(retryPrompt);
        ranked = this.parseRankedJSON(responseText);
      }
    } catch (err) {
      console.warn("Gemini unavailable, using local ranking fallback:", err);
      ranked = fallbackRank(surviving, commuteResults, prefs);
      this.log(
        "llm_to_user",
        "[Gemini unavailable — ranked locally by price, commute, and amenity match]",
      );
    }

    return { listings: surviving, ranked };
  }

  async draftOutreach(
    listing: Listing,
    prefs: UserPreferences,
  ): Promise<string> {
    const prompt = [
      "Draft a short outreach message (≤ 120 words) for this listing on behalf of the user.",
      "Reference at least one specific detail from the listing (price, neighborhood, amenity, or available date).",
      "Do not claim anything you cannot verify. Be warm and concise.",
      "",
      "Listing:",
      JSON.stringify(listing, null, 2),
      "",
      "User preferences:",
      JSON.stringify(prefs, null, 2),
      "",
      "Return ONLY the message text, no subject line, no markdown.",
    ].join("\n");

    try {
      return await this.call(prompt);
    } catch {
      // Generate a simple template when Gemini is unavailable
      return `Hi there!\n\nI came across your listing in ${listing.address} and I'm very interested. I'm an intern moving to the area${prefs.start_date ? ` around ${prefs.start_date}` : ""} and looking for housing${prefs.end_date ? ` through ${prefs.end_date}` : ""}.\n\nWould love to learn more about availability and next steps. Thanks!`;
    }
  }

  async refineMessage(
    _listingId: string,
    instruction: string,
    current: string,
  ): Promise<string> {
    const prompt = [
      "Revise the following outreach message according to the user's instruction.",
      "Return ONLY the revised message text, no commentary.",
      "",
      "Current message:",
      current,
      "",
      "Instruction:",
      instruction,
    ].join("\n");

    return await this.call(prompt);
  }

  async refineSearch(
    instruction: string,
    currentRanked: RankedListing[],
    currentListings: Listing[],
  ): Promise<RankedListing[]> {
    const prompt = [
      "The user wants to re-rank the current listings based on a new instruction.",
      "Do NOT add new listings. Re-rank from the provided set only.",
      "Return ONLY a JSON array of RankedListing objects.",
      "",
      "User instruction:",
      instruction,
      "",
      "Current rankings:",
      JSON.stringify(currentRanked, null, 2),
      "",
      "Available listings:",
      JSON.stringify(currentListings, null, 2),
    ].join("\n");

    let responseText = await this.call(prompt);

    try {
      return this.parseRankedJSON(responseText);
    } catch {
      const retryPrompt =
        responseText +
        "\n\nRespond ONLY with valid JSON matching the RankedListing[] schema. No prose, no markdown.";
      responseText = await this.call(retryPrompt);
      try {
        return this.parseRankedJSON(responseText);
      } catch {
        throw new Error(
          "Gemini returned invalid JSON after retry. Please try again.",
        );
      }
    }
  }
}
