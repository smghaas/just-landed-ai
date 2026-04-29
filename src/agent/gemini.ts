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

    // 5. Call Gemini
    let responseText = await this.call(userPrompt);

    // 6. Parse — retry once if invalid
    let ranked: RankedListing[];
    try {
      ranked = this.parseRankedJSON(responseText);
    } catch {
      const retryPrompt =
        responseText +
        "\n\nRespond ONLY with valid JSON matching the RankedListing[] schema. No prose, no markdown.";
      responseText = await this.call(retryPrompt);
      try {
        ranked = this.parseRankedJSON(responseText);
      } catch {
        throw new Error(
          "Gemini returned invalid JSON after retry. Please try again or switch models in Settings.",
        );
      }
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

    return await this.call(prompt);
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
