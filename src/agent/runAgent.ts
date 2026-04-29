import { useAppStore } from "../state";
import { GeminiAgent } from "./gemini";

let instance: GeminiAgent | null = null;
let lastKey = "";
let lastModel = "";

export function getAgent(): GeminiAgent {
  const { geminiApiKey, model } = useAppStore.getState().settings;

  // Allow empty key — Gemini calls will fail but fallback ranking will work

  if (!instance || geminiApiKey !== lastKey || model !== lastModel) {
    instance = new GeminiAgent(geminiApiKey, model);
    lastKey = geminiApiKey;
    lastModel = model;
  }

  return instance;
}
