import { googleAI } from "@genkit-ai/google-genai";
import { genkit, z, type Genkit, type ModelArgument } from "genkit";
import { SYSTEM_PROMPT } from "./prompts";
import type { StravaActivityUpdate, StravaClient } from "./strava";

const MAX_TOOL_TURNS = 8;
const DEFAULT_MODEL = "gemini-3.8-flash";

export interface AnalyzeActivityInput {
  stravaId: string;
  dryRun?: boolean;
  stravaClient: Pick<
    StravaClient,
    "getStravaActivity" | "getAthleteGear" | "updateStravaActivity"
  >;
  geminiApiKey?: string;
  model?: string;
  ai?: Genkit;
}

export interface AnalyzeActivityResult {
  stravaId: string;
  dryRun: boolean;
  updatesApplied: StravaActivityUpdate | null;
  summary: string;
}

function resolveGenkitContext(input: AnalyzeActivityInput): {
  ai: Genkit;
  model: ModelArgument;
} {
  const modelName = input.model ?? DEFAULT_MODEL;
  if (input.ai) {
    return { ai: input.ai, model: modelName };
  }
  if (!input.geminiApiKey) {
    throw new Error("geminiApiKey is required when ai is not provided.");
  }
  const ai = genkit({
    plugins: [googleAI({ apiKey: input.geminiApiKey })],
  });
  return { ai, model: googleAI.model(modelName) };
}

function buildInitialPrompt(stravaId: string, dryRun: boolean): string {
  const modeNote = dryRun
    ? " (dry-run mode: propose updates via updateStravaActivity without expecting live persistence)"
    : "";
  return `Analyze Strava activity ID "${stravaId}"${modeNote} and apply any matching rules.`;
}

async function applyActivityUpdate(
  stravaClient: AnalyzeActivityInput["stravaClient"],
  activityId: string,
  updates: StravaActivityUpdate,
  dryRun: boolean,
): Promise<Record<string, unknown>> {
  if (dryRun) {
    return { dryRun: true, proposedUpdates: updates };
  }

  const updated = await stravaClient.updateStravaActivity(activityId, updates);
  return {
    updated: true,
    id: updated.id ?? activityId,
    name: updated.name,
    workout_type: updated.workout_type,
    gear_id: updated.gear_id,
  };
}

function createStravaTools(
  ai: Genkit,
  defaultStravaId: string,
  dryRun: boolean,
  stravaClient: AnalyzeActivityInput["stravaClient"],
  onUpdateApplied: (updates: StravaActivityUpdate) => void,
) {
  const getStravaActivity = ai.defineTool(
    {
      name: "getStravaActivity",
      description:
        "Fetch detailed Strava activity data including distance, moving time, heart rate, laps, and heart-rate/pace zone distributions.",
      inputSchema: z.object({
        stravaId: z.string().describe("The numeric Strava activity ID as a string."),
      }),
    },
    async ({ stravaId }) => stravaClient.getStravaActivity(stravaId || defaultStravaId),
  );

  const getAthleteGear = ai.defineTool(
    {
      name: "getAthleteGear",
      description:
        "Fetch the athlete's Strava shoes and bikes so gear names can be resolved to their Strava gear_id.",
      inputSchema: z.object({}),
    },
    async () => stravaClient.getAthleteGear(),
  );

  const updateStravaActivity = ai.defineTool(
    {
      name: "updateStravaActivity",
      description:
        "Update a Strava activity's title (name), workout_type (0=Default, 1=Race, 2=Long Run, 3=Workout), gear_id, or description.",
      inputSchema: z.object({
        stravaId: z.string().describe("The numeric Strava activity ID as a string."),
        name: z.string().optional().describe("New activity title."),
        workout_type: z
          .number()
          .int()
          .optional()
          .describe("Strava workout_type for runs: 0=Default, 1=Race, 2=Long Run, 3=Workout."),
        gear_id: z
          .string()
          .optional()
          .describe("Strava gear ID (e.g. g12345678) from getAthleteGear."),
        description: z.string().optional().describe("Optional activity description."),
      }),
    },
    async ({ stravaId, ...updates }) => {
      onUpdateApplied(updates);
      return applyActivityUpdate(stravaClient, stravaId || defaultStravaId, updates, dryRun);
    },
  );

  return [getStravaActivity, getAthleteGear, updateStravaActivity];
}

/**
 * Run the Genkit tool-calling loop to analyze and optionally update a Strava activity.
 */
export async function analyzeAndUpdateActivity(
  input: AnalyzeActivityInput,
): Promise<AnalyzeActivityResult> {
  const { stravaId, dryRun = false, stravaClient } = input;
  const { ai, model } = resolveGenkitContext(input);

  let updatesApplied: StravaActivityUpdate | null = null;
  const tools = createStravaTools(ai, stravaId, dryRun, stravaClient, (updates) => {
    updatesApplied = updates;
  });

  const response = await ai.generate({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildInitialPrompt(stravaId, dryRun),
    tools,
    maxTurns: MAX_TOOL_TURNS,
    config: {
      thinkingConfig: { thinkingLevel: "LOW" },
    },
  });

  return {
    stravaId,
    dryRun,
    updatesApplied,
    summary: response.text.trim() || "Analysis complete.",
  };
}
