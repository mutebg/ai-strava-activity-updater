import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { SYSTEM_PROMPT } from "./prompts";
import type { StravaActivityUpdate, StravaClient } from "./strava";

const MAX_TOOL_TURNS = 8;
const DEFAULT_MODEL = "gemini-3.8-flash";

export const STRAVA_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "getStravaActivity",
    description:
      "Fetch detailed Strava activity data including distance, moving time, heart rate, laps, and heart-rate/pace zone distributions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        stravaId: {
          type: Type.STRING,
          description: "The numeric Strava activity ID as a string.",
        },
      },
      required: ["stravaId"],
    },
  },
  {
    name: "getAthleteGear",
    description:
      "Fetch the athlete's Strava shoes and bikes so gear names can be resolved to their Strava gear_id.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "updateStravaActivity",
    description:
      "Update a Strava activity's title (name), workout_type (0=Default, 1=Race, 2=Long Run, 3=Workout), gear_id, or description.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        stravaId: {
          type: Type.STRING,
          description: "The numeric Strava activity ID as a string.",
        },
        name: {
          type: Type.STRING,
          description: "New activity title.",
        },
        workout_type: {
          type: Type.INTEGER,
          description: "Strava workout_type for runs: 0=Default, 1=Race, 2=Long Run, 3=Workout.",
        },
        gear_id: {
          type: Type.STRING,
          description: "Strava gear ID (e.g. g12345678) from getAthleteGear.",
        },
        description: {
          type: Type.STRING,
          description: "Optional activity description.",
        },
      },
      required: ["stravaId"],
    },
  },
];

export interface ModelTurnResult {
  text?: string;
  functionCalls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }>;
  modelContent?: Content;
}

export type GenerateTurnFn = (params: {
  contents: Content[];
  systemInstruction: string;
  functionDeclarations: FunctionDeclaration[];
}) => Promise<ModelTurnResult>;

export interface AnalyzeActivityInput {
  stravaId: string;
  dryRun?: boolean;
  stravaClient: Pick<
    StravaClient,
    "getStravaActivity" | "getAthleteGear" | "updateStravaActivity"
  >;
  geminiApiKey?: string;
  model?: string;
  generateTurn?: GenerateTurnFn;
}

export interface AnalyzeActivityResult {
  stravaId: string;
  dryRun: boolean;
  updatesApplied: StravaActivityUpdate | null;
  summary: string;
}

function createDefaultGenerateTurn(apiKey: string, model: string): GenerateTurnFn {
  const ai = new GoogleGenAI({ apiKey });
  return async ({ contents, systemInstruction, functionDeclarations }) => {
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });

    const functionCalls = response.functionCalls?.map((fc) => ({
      name: fc.name,
      args: fc.args as Record<string, unknown> | undefined,
    }));

    return {
      text: functionCalls?.length ? undefined : response.text,
      functionCalls,
      modelContent: response.candidates?.[0]?.content,
    };
  };
}

interface ToolExecutionContext {
  stravaId: string;
  dryRun: boolean;
  stravaClient: AnalyzeActivityInput["stravaClient"];
}

interface ToolCallResult {
  responsePart: Part;
  appliedUpdate?: StravaActivityUpdate;
}

function resolveGenerateTurn(input: AnalyzeActivityInput): GenerateTurnFn {
  if (input.generateTurn) {
    return input.generateTurn;
  }
  if (!input.geminiApiKey) {
    throw new Error("geminiApiKey is required when generateTurn is not provided.");
  }
  return createDefaultGenerateTurn(input.geminiApiKey, input.model ?? DEFAULT_MODEL);
}

function buildInitialContent(stravaId: string, dryRun: boolean): Content {
  const modeNote = dryRun
    ? " (dry-run mode: propose updates via updateStravaActivity without expecting live persistence)"
    : "";
  return {
    role: "user",
    parts: [
      {
        text: `Analyze Strava activity ID "${stravaId}"${modeNote} and apply any matching rules.`,
      },
    ],
  };
}

function parseActivityUpdate(args: Record<string, unknown>): StravaActivityUpdate {
  const updates: StravaActivityUpdate = {};
  if (typeof args.name === "string") updates.name = args.name;
  if (typeof args.workout_type === "number") updates.workout_type = args.workout_type;
  if (typeof args.gear_id === "string") updates.gear_id = args.gear_id;
  if (typeof args.description === "string") updates.description = args.description;
  return updates;
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

async function executeToolCall(
  call: { name?: string; args?: Record<string, unknown> },
  context: ToolExecutionContext,
): Promise<ToolCallResult> {
  const name = call.name ?? "";
  const args = call.args ?? {};
  let toolOutput: unknown;
  let appliedUpdate: StravaActivityUpdate | undefined;

  try {
    if (name === "getStravaActivity") {
      const id = String(args.stravaId ?? context.stravaId);
      toolOutput = await context.stravaClient.getStravaActivity(id);
    } else if (name === "getAthleteGear") {
      toolOutput = await context.stravaClient.getAthleteGear();
    } else if (name === "updateStravaActivity") {
      const id = String(args.stravaId ?? context.stravaId);
      const updates = parseActivityUpdate(args);
      appliedUpdate = updates;
      toolOutput = await applyActivityUpdate(
        context.stravaClient,
        id,
        updates,
        context.dryRun,
      );
    } else {
      toolOutput = { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    toolOutput = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    responsePart: {
      functionResponse: {
        name,
        response: { result: toolOutput },
      },
    },
    appliedUpdate,
  };
}

async function executeToolCalls(
  calls: Array<{ name?: string; args?: Record<string, unknown> }>,
  context: ToolExecutionContext,
): Promise<{ responseParts: Part[]; appliedUpdate?: StravaActivityUpdate }> {
  const responseParts: Part[] = [];
  let appliedUpdate: StravaActivityUpdate | undefined;

  for (const call of calls) {
    const result = await executeToolCall(call, context);
    responseParts.push(result.responsePart);
    if (result.appliedUpdate) {
      appliedUpdate = result.appliedUpdate;
    }
  }

  return { responseParts, appliedUpdate };
}

/**
 * Run the Gemini tool-calling loop to analyze and optionally update a Strava activity.
 */
export async function analyzeAndUpdateActivity(
  input: AnalyzeActivityInput,
): Promise<AnalyzeActivityResult> {
  const { stravaId, dryRun = false, stravaClient } = input;
  const generateTurn = resolveGenerateTurn(input);
  const contents: Content[] = [buildInitialContent(stravaId, dryRun)];

  let updatesApplied: StravaActivityUpdate | null = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const result = await generateTurn({
      contents,
      systemInstruction: SYSTEM_PROMPT,
      functionDeclarations: STRAVA_TOOL_DECLARATIONS,
    });

    if (result.modelContent) {
      contents.push(result.modelContent);
    }

    const calls = result.functionCalls ?? [];
    if (calls.length === 0) {
      return {
        stravaId,
        dryRun,
        updatesApplied,
        summary: result.text?.trim() || "Analysis complete.",
      };
    }

    const { responseParts, appliedUpdate } = await executeToolCalls(calls, {
      stravaId,
      dryRun,
      stravaClient,
    });

    if (appliedUpdate) {
      updatesApplied = appliedUpdate;
    }

    contents.push({
      role: "user",
      parts: responseParts,
    });
  }

  throw new Error(`Agent exceeded maximum tool turns (${MAX_TOOL_TURNS}) for activity ${stravaId}.`);
}
