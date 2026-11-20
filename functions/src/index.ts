import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { analyzeAndUpdateActivity } from "./agent";
import { StravaClient } from "./strava";

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const stravaClientId = defineSecret("STRAVA_CLIENT_ID");
const stravaClientSecret = defineSecret("STRAVA_CLIENT_SECRET");
const stravaRefreshToken = defineSecret("STRAVA_REFRESH_TOKEN");
const appApiKey = defineSecret("APP_API_KEY");

/**
 * HTTP endpoint that accepts `{ stravaId, dryRun? }` and runs the AI activity updater.
 */
export const processStravaActivity = onRequest(
  {
    secrets: [
      geminiApiKey,
      stravaClientId,
      stravaClientSecret,
      stravaRefreshToken,
      appApiKey,
    ],
    timeoutSeconds: 120,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed. Use POST." });
      return;
    }

    const expectedApiKey = appApiKey.value();
    const providedApiKey = req.header("x-api-key");
    if (expectedApiKey && providedApiKey !== expectedApiKey) {
      res.status(401).json({ error: "Unauthorized: invalid or missing x-api-key header." });
      return;
    }

    const rawId = req.body?.stravaId;
    if (rawId === undefined || rawId === null || String(rawId).trim() === "") {
      res.status(400).json({ error: "Missing required field: stravaId" });
      return;
    }

    const stravaId = String(rawId).trim();
    const dryRun = Boolean(req.body?.dryRun);

    try {
      const stravaClient = new StravaClient({
        clientId: stravaClientId.value(),
        clientSecret: stravaClientSecret.value(),
        refreshToken: stravaRefreshToken.value(),
      });

      const result = await analyzeAndUpdateActivity({
        stravaId,
        dryRun,
        stravaClient,
        geminiApiKey: geminiApiKey.value(),
      });

      res.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to process Strava activity:", message);
      res.status(500).json({ error: message });
    }
  },
);
