export interface StravaClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export interface StravaGearItem {
  id: string;
  name: string;
  primary: boolean;
  distanceKm: number;
  type: "shoe" | "bike";
}

export interface StravaLapSummary {
  lapIndex: number;
  name: string;
  distanceKm: number;
  movingTimeSec: number;
  averageSpeedMps: number;
  averagePace?: string;
  averageHeartrate?: number;
  maxHeartrate?: number;
}

export interface StravaZoneBucket {
  min: number;
  max: number;
  timeSec: number;
}

export interface StravaZoneDistribution {
  type: string;
  buckets: StravaZoneBucket[];
}

export interface StravaActivitySummary {
  id: string;
  name: string;
  sportType: string;
  type: string;
  workoutType: number | null;
  gearId: string | null;
  distanceKm: number;
  movingTimeSec: number;
  elapsedTimeSec: number;
  totalElevationGainM: number;
  averageSpeedMps: number;
  averageHeartrate?: number;
  maxHeartrate?: number;
  description?: string | null;
  laps: StravaLapSummary[];
  zones: StravaZoneDistribution[];
}

export interface StravaActivityUpdate {
  name?: string;
  workout_type?: number;
  gear_id?: string;
  description?: string;
}

interface TokenResponse {
  access_token: string;
  expires_at: number;
  refresh_token?: string;
}

const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const STRAVA_OAUTH_URL = "https://www.strava.com/oauth/token";

function formatPace(speedMps: number): string | undefined {
  if (!Number.isFinite(speedMps) || speedMps <= 0) return undefined;
  const secPerKm = Math.round(1000 / speedMps);
  const mins = Math.floor(secPerKm / 60);
  const secs = secPerKm % 60;
  return `${mins}:${String(secs).padStart(2, "0")}/km`;
}

function parseZones(rawZones: Array<Record<string, unknown>>): StravaZoneDistribution[] {
  return rawZones.map((z) => ({
    type: String(z.type ?? "unknown"),
    buckets: Array.isArray(z.distribution_buckets)
      ? z.distribution_buckets.map((b: Record<string, unknown>) => ({
          min: Number(b.min ?? 0),
          max: Number(b.max ?? 0),
          timeSec: Number(b.time ?? 0),
        }))
      : [],
  }));
}

function parseLaps(rawLaps: Array<Record<string, unknown>>): StravaLapSummary[] {
  return rawLaps.map((lap, idx) => {
    const avgSpeedMps = Number(lap.average_speed ?? 0);
    return {
      lapIndex: idx + 1,
      name: String(lap.name ?? `Lap ${idx + 1}`),
      distanceKm: Number(((Number(lap.distance ?? 0)) / 1000).toFixed(2)),
      movingTimeSec: Number(lap.moving_time ?? 0),
      averageSpeedMps: avgSpeedMps,
      averagePace: formatPace(avgSpeedMps),
      averageHeartrate: lap.average_heartrate !== undefined ? Number(lap.average_heartrate) : undefined,
      maxHeartrate: lap.max_heartrate !== undefined ? Number(lap.max_heartrate) : undefined,
    };
  });
}

/**
 * Lightweight Strava API v3 client using OAuth2 refresh tokens.
 */
export class StravaClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken: string;
  private readonly fetchFn: typeof fetch;
  private accessToken: string | null = null;
  private expiresAtSec = 0;

  constructor(config: StravaClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.fetchFn = config.fetchImpl ?? fetch;
  }

  private async getAccessToken(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.accessToken && nowSec < this.expiresAtSec - 60) {
      return this.accessToken;
    }

    const res = await this.fetchFn(STRAVA_OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Strava OAuth refresh failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.expiresAtSec = data.expires_at;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
    return this.accessToken;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const res = await this.fetchFn(`${STRAVA_API_BASE}${path}`, {
      signal: AbortSignal.timeout(15000),
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Strava API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
    }

    return (await res.json()) as T;
  }

  private async fetchActivityZones(activityId: string): Promise<StravaZoneDistribution[]> {
    try {
      const rawZones = await this.request<Array<Record<string, unknown>>>(
        `/activities/${encodeURIComponent(activityId)}/zones`,
      );
      return parseZones(rawZones);
    } catch {
      // Zones endpoint can return 404/403 on activities without HR/pace data or certain account tiers.
      return [];
    }
  }

  /**
   * Fetch activity details and HR/pace zone distributions for a Strava activity.
   */
  async getStravaActivity(activityId: string): Promise<StravaActivitySummary> {
    const activity = await this.request<Record<string, unknown>>(
      `/activities/${encodeURIComponent(activityId)}?include_all_efforts=true`,
    );

    const zones = await this.fetchActivityZones(activityId);
    const rawLaps = Array.isArray(activity.laps) ? (activity.laps as Array<Record<string, unknown>>) : [];
    const laps = parseLaps(rawLaps);

    return {
      id: String(activity.id ?? activityId),
      name: String(activity.name ?? ""),
      sportType: String(activity.sport_type ?? activity.type ?? ""),
      type: String(activity.type ?? ""),
      workoutType: activity.workout_type !== undefined && activity.workout_type !== null
        ? Number(activity.workout_type)
        : null,
      gearId: activity.gear_id ? String(activity.gear_id) : null,
      distanceKm: Number(((Number(activity.distance ?? 0)) / 1000).toFixed(2)),
      movingTimeSec: Number(activity.moving_time ?? 0),
      elapsedTimeSec: Number(activity.elapsed_time ?? 0),
      totalElevationGainM: Number(activity.total_elevation_gain ?? 0),
      averageSpeedMps: Number(activity.average_speed ?? 0),
      averageHeartrate: activity.average_heartrate !== undefined ? Number(activity.average_heartrate) : undefined,
      maxHeartrate: activity.max_heartrate !== undefined ? Number(activity.max_heartrate) : undefined,
      description: activity.description ? String(activity.description) : null,
      laps,
      zones,
    };
  }

  /**
   * Fetch all shoes and bikes configured on the authenticated athlete's profile.
   */
  async getAthleteGear(): Promise<StravaGearItem[]> {
    const athlete = await this.request<Record<string, unknown>>("/athlete");
    const shoes = Array.isArray(athlete.shoes) ? (athlete.shoes as Array<Record<string, unknown>>) : [];
    const bikes = Array.isArray(athlete.bikes) ? (athlete.bikes as Array<Record<string, unknown>>) : [];
    const mapItem = (item: Record<string, unknown>, type: "shoe" | "bike"): StravaGearItem => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? ""),
      primary: Boolean(item.primary),
      distanceKm: Number(((Number(item.distance ?? 0)) / 1000).toFixed(1)),
      type,
    });

    return [
      ...shoes.map((s) => mapItem(s, "shoe")),
      ...bikes.map((b) => mapItem(b, "bike")),
    ];
  }

  /**
   * Update an existing Strava activity (title, workout_type, gear_id, description).
   */
  async updateStravaActivity(
    activityId: string,
    updates: StravaActivityUpdate,
  ): Promise<Record<string, unknown>> {
    const payload: StravaActivityUpdate = {};
    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.workout_type !== undefined) payload.workout_type = updates.workout_type;
    if (updates.gear_id !== undefined) payload.gear_id = updates.gear_id;
    if (updates.description !== undefined) payload.description = updates.description;

    return this.request<Record<string, unknown>>(`/activities/${encodeURIComponent(activityId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }
}
