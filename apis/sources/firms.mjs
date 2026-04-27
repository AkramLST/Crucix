// NASA FIRMS — Fire Information for Resource Management System
// Detects active fires/thermal anomalies globally within 3 hours of satellite pass.
// Detects military strikes, explosions, wildfires, industrial fires.

import "../utils/env.mjs";

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

// Parse FIRMS CSV response into structured data
function parseCSV(rawText) {
  if (!rawText || typeof rawText !== "string") {
    console.error("❌ Invalid CSV input");
    return [];
  }

  // Detect if response is NOT CSV (very important)
  if (rawText.startsWith("<!DOCTYPE") || rawText.startsWith("<html")) {
    console.error("🚨 Response is HTML, NOT CSV!");
    return [];
  }

  const lines = rawText.trim().split("\n");

  if (lines.length < 2) {
    console.warn("⚠️ CSV has no data rows");
    return [];
  }

  const headers = lines[0].split(",");
  console.log("🧾 CSV Headers:", headers);

  const data = lines.slice(1).map((line, index) => {
    const vals = line.split(",");
    const obj = {};

    headers.forEach((h, i) => {
      obj[h.trim()] = vals[i]?.trim();
    });

    return obj;
  });

  return data;
}

// Fetch fires in a bounding box
async function fetchFires(opts = {}) {
  const {
    west = -180,
    south = -90,
    east = 180,
    north = 90,
    days = 1,
    source = "VIIRS_SNPP_NRT",
  } = opts;

  const key = "fcddc61b2bcfef6e3174baafa6e5b029";
  if (!key) {
    console.error("❌ FIRMS API key missing");
    return { error: "No FIRMS_MAP_KEY" };
  }

  const url = `${FIRMS_BASE}/${key}/${source}/${west},${south},${east},${north}/${days}`;
  console.log("\n🌍 FIRMS Request URL:");
  console.log(url);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.error("⏱️ Request timed out");
    controller.abort();
  }, 25000);

  try {
    console.log("📡 Sending request to FIRMS...");

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "PostmanRuntime/7.32.3",
        Accept: "*/*",
      },
    });

    clearTimeout(timer);

    console.log(`✅ Response received: HTTP ${res.status}`);

    const text = await res.text();

    console.log("📦 Raw response preview (first 300 chars):");
    console.log(text.slice(0, 300));

    if (!res.ok) {
      console.error("❌ Non-200 response from FIRMS");
      return { error: `HTTP ${res.status}`, raw: text };
    }

    const parsed = parseCSV(text);

    console.log(`📊 Parsed ${parsed.length} fire records`);

    return parsed;
  } catch (e) {
    clearTimeout(timer);
    console.error("🔥 Fetch error:", e);
    return { error: e.message };
  }
}

// Key conflict/hotspot zones
const HOTSPOTS = {
  middleEast: {
    west: 30,
    south: 12,
    east: 65,
    north: 42,
    label: "Middle East",
  },
  ukraine: { west: 22, south: 44, east: 41, north: 53, label: "Ukraine" },
  iran: { west: 44, south: 25, east: 63, north: 40, label: "Iran" },
  sudanHorn: {
    west: 21,
    south: 2,
    east: 52,
    north: 23,
    label: "Sudan / Horn of Africa",
  },
  myanmar: { west: 92, south: 9, east: 102, north: 29, label: "Myanmar" },
  southAsia: { west: 60, south: 5, east: 98, north: 37, label: "South Asia" },
};

// Analyze fire detections for potential military/strike activity
function analyzeFires(fires, regionLabel) {
  if (!Array.isArray(fires) || fires.length === 0) {
    return {
      region: regionLabel,
      totalDetections: 0,
      highConfidence: 0,
      highIntensity: [],
      summary: "No detections",
    };
  }

  const highConf = fires.filter(
    (f) => f.confidence === "h" || f.confidence === "high",
  );
  const nomConf = fires.filter(
    (f) => f.confidence === "n" || f.confidence === "nominal",
  );

  // High intensity fires (FRP > 10 MW) — potential strikes, industrial fires, large explosions
  const highIntensity = fires
    .filter((f) => parseFloat(f.frp) > 10)
    .map((f) => ({
      lat: parseFloat(f.latitude),
      lon: parseFloat(f.longitude),
      brightness: parseFloat(f.bright_ti4),
      frp: parseFloat(f.frp),
      date: f.acq_date,
      time: f.acq_time,
      confidence: f.confidence,
      daynight: f.daynight,
    }))
    .sort((a, b) => b.frp - a.frp)
    .slice(0, 15);

  // Night detections are more significant (less likely agricultural burning)
  const nightFires = fires.filter((f) => f.daynight === "N");

  return {
    region: regionLabel,
    totalDetections: fires.length,
    highConfidence: highConf.length,
    nominalConfidence: nomConf.length,
    nightDetections: nightFires.length,
    highIntensity,
    avgFRP:
      fires.reduce((sum, f) => sum + (parseFloat(f.frp) || 0), 0) /
      fires.length,
  };
}

// Briefing
export async function briefing() {
  const key = "fcddc61b2bcfef6e3174baafa6e5b029";
  if (!key) {
    return {
      source: "NASA FIRMS",
      timestamp: new Date().toISOString(),
      status: "no_key",
      message:
        "Set FIRMS_MAP_KEY for satellite fire/strike detection. Free at https://firms.modaps.eosdis.nasa.gov/api/area/",
    };
  }

  // Fetch all hotspots in parallel
  const entries = Object.entries(HOTSPOTS);
  const rawResults = await Promise.all(
    entries.map(async ([key, box]) => {
      const fires = await fetchFires({ ...box, days: 2 });
      return { key, label: box.label, fires };
    }),
  );

  const hotspots = rawResults.map((r) => {
    if (r.fires?.error) return { region: r.label, error: r.fires.error };
    return analyzeFires(r.fires, r.label);
  });

  // Generate signals
  const signals = [];
  for (const h of hotspots) {
    if (h.highIntensity?.length > 5) {
      signals.push(
        `HIGH INTENSITY FIRES in ${h.region}: ${h.highIntensity.length} detections >10MW FRP`,
      );
    }
    if (h.nightDetections > 20) {
      signals.push(
        `ELEVATED NIGHT ACTIVITY in ${h.region}: ${h.nightDetections} night detections (potential strikes/combat)`,
      );
    }
  }

  return {
    source: "NASA FIRMS",
    timestamp: new Date().toISOString(),
    status: "active",
    hotspots,
    signals,
  };
}

if (process.argv[1]?.endsWith("firms.mjs")) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
