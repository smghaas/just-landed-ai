import { create } from "zustand";
import type {
  AppSettings,
  UserPreferences,
  Listing,
  RankedListing,
  QALogEntry,
} from "./types";

interface AppState {
  settings: AppSettings;
  prefs: UserPreferences | null;
  listings: Listing[];
  rankedListings: RankedListing[];
  qaLog: QALogEntry[];

  setSettings: (settings: AppSettings) => void;
  setPrefs: (prefs: UserPreferences | null) => void;
  setListings: (listings: Listing[]) => void;
  setRankedListings: (rankedListings: RankedListing[]) => void;
  setQaLog: (qaLog: QALogEntry[]) => void;
  appendUserToLLM: (text: string) => void;
  appendLLMToUser: (text: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  settings: {
    geminiApiKey: import.meta.env.VITE_GEMINI_API_KEY ?? "",
    mapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "",
    rentcastApiKey: import.meta.env.VITE_RENTCAST_API_KEY ?? "",
    model: "gemini-2.5-flash",
    useSyntheticData: true,
    rapidApiZillowKey: "",
    corsProxyUrl: "https://api.allorigins.win/raw?url=",
    interMbaExtraGids: {},
  },
  prefs: null,
  listings: [],
  rankedListings: [],
  qaLog: [],

  setSettings: (settings) => set({ settings }),
  setPrefs: (prefs) => set({ prefs }),
  setListings: (listings) => set({ listings }),
  setRankedListings: (rankedListings) => set({ rankedListings }),
  setQaLog: (qaLog) => set({ qaLog }),

  appendUserToLLM: (text) =>
    set((state) => ({
      qaLog: [
        ...state.qaLog,
        {
          ts: new Date().toISOString(),
          direction: "user_to_llm" as const,
          text,
        },
      ],
    })),

  appendLLMToUser: (text) =>
    set((state) => ({
      qaLog: [
        ...state.qaLog,
        {
          ts: new Date().toISOString(),
          direction: "llm_to_user" as const,
          text,
        },
      ],
    })),
}));
