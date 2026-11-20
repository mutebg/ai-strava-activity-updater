import test from "node:test";
import assert from "node:assert/strict";
import { StravaClient } from "../src/strava";
import { analyzeAndUpdateActivity, type GenerateTurnFn } from "../src/agent";

test("StravaClient refreshes token once and fetches activity + zones", async () => {
  const calls: Array<{ url: string; method: string }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/activities/123?include_all_efforts=true")) {
      return new Response(
        JSON.stringify({
          id: 123,
          name: "Morning Run",
          type: "Run",
          sport_type: "Run",
          distance: 10000,
          moving_time: 3000,
          elapsed_time: 3050,
          total_elevation_gain: 50,
          average_speed: 3.33,
          average_heartrate: 138,
          laps: [],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/activities/123/zones")) {
      return new Response(
        JSON.stringify([
          {
            type: "heartrate",
            distribution_buckets: [{ min: 120, max: 145, time: 2800 }],
          },
        ]),
        { status: 200 },
      );
    }
    if (url.endsWith("/athlete")) {
      return new Response(
        JSON.stringify({
          shoes: [{ id: "g111", name: "Adidas Adizero Evo SL", primary: true, distance: 120000 }],
          bikes: [],
        }),
        { status: 200 },
      );
    }

    return new Response("Not found", { status: 404 });
  };

  const client = new StravaClient({
    clientId: "cid",
    clientSecret: "csec",
    refreshToken: "rtok",
    fetchImpl: mockFetch,
  });

  const activity = await client.getStravaActivity("123");
  assert.equal(activity.distanceKm, 10);
  assert.equal(activity.zones.length, 1);

  const gear = await client.getAthleteGear();
  assert.equal(gear[0]?.id, "g111");

  const oauthCalls = calls.filter((c) => c.url.includes("/oauth/token"));
  assert.equal(oauthCalls.length, 1, "OAuth token should be cached across calls");
});

test("analyzeAndUpdateActivity runs tool loop and respects dryRun", async () => {
  let updateCalled = false;
  const mockStrava = {
    async getStravaActivity(id: string) {
      return {
        id,
        name: "Afternoon Run",
        sportType: "Run",
        type: "Run",
        workoutType: 0,
        gearId: null,
        distanceKm: 20.5,
        movingTimeSec: 6200,
        elapsedTimeSec: 6300,
        totalElevationGainM: 120,
        averageSpeedMps: 3.3,
        laps: [],
        zones: [],
      };
    },
    async getAthleteGear() {
      return [
        { id: "g-asics", name: "Asics Megablast", primary: false, distanceKm: 50, type: "shoe" as const },
      ];
    },
    async updateStravaActivity() {
      updateCalled = true;
      return {};
    },
  };

  let turn = 0;
  const mockGenerateTurn: GenerateTurnFn = async () => {
    turn++;
    if (turn === 1) {
      return {
        functionCalls: [
          { name: "getStravaActivity", args: { stravaId: "999" } },
          { name: "getAthleteGear", args: {} },
        ],
      };
    }
    if (turn === 2) {
      return {
        functionCalls: [
          {
            name: "updateStravaActivity",
            args: { stravaId: "999", name: "Long run", gear_id: "g-asics" },
          },
        ],
      };
    }
    return { text: "Classified as Long run (> 18 km) and proposed Asics Megablast." };
  };

  const dryResult = await analyzeAndUpdateActivity({
    stravaId: "999",
    dryRun: true,
    stravaClient: mockStrava,
    generateTurn: mockGenerateTurn,
  });

  assert.equal(updateCalled, false);
  assert.deepEqual(dryResult.updatesApplied, { name: "Long run", gear_id: "g-asics" });
  assert.match(dryResult.summary, /Long run/);
});
