# AI Strava Activity Updater

A Firebase Function (v2, TypeScript) that accepts a Strava activity ID, uses Gemini (`@google/genai`) with function calling (`getStravaActivity`, `getAthleteGear`, `updateStravaActivity`) to analyze the run, and updates its title, workout label, and gear on Strava.

## Project Structure

- `functions/src/index.ts` — `processStravaActivity` HTTP Firebase Function (`POST`)
- `functions/src/agent.ts` — Gemini tool-calling loop
- `functions/src/strava.ts` — Strava API v3 client with OAuth2 token refresh
- `functions/src/prompts.ts` — Activity classification rules & system prompt (edit this to customize rules)
- `functions/test/agent.test.ts` — Unit tests

## Setup

### 1. Install dependencies
```bash
cd functions
npm install
```

### 2. Configure Firebase Project & Secrets
Link your Firebase project (if not already linked):
```bash
firebase use --add
```

Set the required secrets in Firebase:
```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set STRAVA_CLIENT_ID
firebase functions:secrets:set STRAVA_CLIENT_SECRET
firebase functions:secrets:set STRAVA_REFRESH_TOKEN
firebase functions:secrets:set APP_API_KEY
```

> **Note on Strava OAuth**: Ensure your `STRAVA_REFRESH_TOKEN` was authorized with `activity:read_all,activity:write` (and `profile:read_all` if needed for gear) scopes so the function can read private activities, zones, and update them.

### 3. Build & Test
```bash
cd functions
npm run build
npm test
```

### 4. Run Locally with Emulator
```bash
cd functions
npm run serve
```

Test in `dryRun: true` mode first (does not modify Strava):
```bash
curl -X POST http://127.0.0.1:5001/<your-project-id>/us-central1/processStravaActivity \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-app-api-key>" \
  -d '{"stravaId": 1234567890, "dryRun": true}'
```

### 5. Deploy
```bash
firebase deploy --only functions
```
