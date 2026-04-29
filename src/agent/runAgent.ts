import { useAppStore } from "../state";
import { GeminiAgent } from "./gemini";

let instance: GeminiAgent | null = null;
let lastKey = "";
let lastModel = "";

export function getAgent(): GeminiAgent {
  const { geminiApiKey, model } = useAppStore.getState().settings;

  if (!geminiApiKey) {
    throw new Error(
      "Gemini API key not set \u2014 open Settings tab to add one",
    );
  }

  if (!instance || geminiApiKey !== lastKey || model !== lastModel) {
    instance = new GeminiAgent(geminiApiKey, model);
    lastKey = geminiApiKey;
    lastModel = model;
  }

  return instance;
}
