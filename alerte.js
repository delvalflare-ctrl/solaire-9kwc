const fs = require("fs");

const API_URL = "http://www.infoclimat.fr/public-api/gfs/json?_ll=49.75071,1.44556&_auth=BhwHEA9xVXcALVBnVyFXflY%2BAjdeKFB3AHxVNgltXyIHY1Y3D2xTNlQ6BnsPIFZjUn8DZ1phAD0BZwtqWCpTLwZmB2MPb1U1AGlQNFdmV3xWegJ%2FXmBQdwB8VToJbF8iB2VWNQ9vUy9UOgZgDzlWfFJgA2ZaYQAnAX0LbVgyUzkGYAdgD2RVNQBtUDVXbld8VnoCZF4zUGgAYFU3CTdfPAdjVmEPOFMzVDIGYg84VnxSYwNrWmcAOwFnC2tYPVM5BnoHfA8VVUQAclByVyVXNlYjAn9eNFA2ADc%3D&_c=edd53741b7202607266d3ed621e05e33";
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const WINDOW_WATTS = Number(process.env.WINDOW_WATTS || 500);
const PUSH_WATTS = Number(process.env.PUSH_WATTS || 800);
const MORNING_PUSH_TIME = process.env.MORNING_PUSH_TIME || "06:30";
const REALTIME_WINDOW = process.env.REALTIME_WINDOW || "06:00-20:00";

const LAT = 49.75071, LON = 1.44556, KWP = 9.0, AZIMUTH = 114, TILT = 45, PR = 0.82;

function parseHHMM(str, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((str || "").trim());
  if (!match) return fallback;
  return { h: Number(match[1]), m: Number(match[2]) };
}

function isWithinWindow(minutesOfDay, rangeStr) {
  const parts = (rangeStr || "00:00-23:59").split("-");
  if (parts.length !== 2) return true;
  const start = parseHHMM(parts[0], { h: 0, m: 0 });
  const end = parseHHMM(parts[1], { h: 23, m: 59 });
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  if (startMin <= endMin) return minutesOfDay >= startMin && minutesOfDay <= endMin;
  return minutesOfDay >= startMin || minutesOfDay <= endMin;
}

function estimatePVWatts(date, clouds) {
  const rad = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);
  const hourUTC = date.getUTCHours() + date.getUTCMinutes() / 60;
  const B = (360 / 365) * (dayOfYear - 81) * rad;
  const decl = 23.45 * Math.sin(B) * rad;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const hourAngle = (hourUTC + LON / 15 + eot / 60 - 12) * 15 * rad;
  const latRad = LAT * rad;
  const sinElev = Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  const elevRad = Math.asin(Math.max(-1, Math.min(1, sinElev)));
  const elevDeg = elevRad / rad;
  if (elevDeg <= 1) return 0;

  let cosAz = (Math.sin(decl) - Math.sin(elevRad) * Math.sin(latRad)) / (Math.cos(elevRad) * Math.cos(latRad));
  let azDeg = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if (hourAngle > 0) azDeg = 360 - azDeg;

  const airMass = 1 / (Math.sin(elevRad) + 0.50572 * Math.pow(elevDeg + 6.07995, -1.6364));
  const dniClear = 1361 * Math.pow(0.7, Math.pow(airMass, 0.678));
  const dhiClear = 0.12 * dniClear * Math.sin(elevRad);

  const low = (clouds.basse || 0) / 100, mid = (clouds.moyenne || 0) / 100, high = (clouds.haute || 0) / 100;
  const trans = (1 - 0.78 * low) * (1 - 0.50 * mid) * (1 - 0.18 * high);
  const cosTheta = Math.sin(elevRad) * Math.cos(TILT * rad) + Math.cos(elevRad) * Math.sin(TILT * rad) * Math.cos((azDeg - AZIMUTH) * rad);
  const poa = Math.max(0, dniClear * trans * Math.max(0, cosTheta)) + dhiClear * ((1 + Math.cos(TILT * rad)) / 2);

  return Math.round(Math.min(KWP * 1000, KWP * 1000 * (poa / 1000) * PR));
}

async function sendPush(title, message, tags = "sunny") {
  if (!NTFY_TOPIC) {
    console.log("[DRY-RUN] Push:", title, "-", message);
    return;
  }
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { "Title": title, "Tags": tags },
    body: message
  });
}

async function run() {
  const res = await fetch(API_URL);
  const raw = await res.json();

  // Sauvegarde le flux brut pour l'application mobile (evite les blocages CORS/HTTP)
  if (raw && raw.request_state === 200) {
    fs.writeFileSync("data.json", JSON.stringify({ updated_at: Date.now(), payload: raw }));
  }

  const points = Object.entries(raw)
    .filter(([k, v]) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(k) && v.nebulosite)
    .map(([k, v]) => ({ dt: new Date(k.replace(" ", "T") + "Z"), neb: v.nebulosite }))
    .sort((a, b) => a.dt - b.dt);

  const slots = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i], p2 = points[i + 1];
    const steps = Math.round((p2.dt - p1.dt) / (30 * 60000));
    for (let s = 0; s < steps; s++) {
      const r = s / steps;
      const dt = new Date(p1.dt.getTime() + s * 30 * 60000);
      const neb = {
        basse: p1.neb.basse + (p2.neb.basse - p1.neb.basse) * r,
        moyenne: p1.neb.moyenne + (p2.neb.moyenne - p1.neb.moyenne) * r,
        haute: p1.neb.haute + (p2.neb.haute - p1.neb.haute) * r
      };
      slots.push({ dt, watts: estimatePVWatts(dt, neb) });
    }
  }

  const now = new Date();
  const parisTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  const nowMinutes = parisTime.getHours() * 60 + parisTime.getMinutes();

  const morningTarget = parseHHMM(MORNING_PUSH_TIME, { h: 6, m: 30 });
  const morningTargetMin = morningTarget.h * 60 + morningTarget.m;
  if (Math.abs(nowMinutes - morningTargetMin) <= 15) {
    const todaySlots = slots.filter(s => s.dt > now && s.dt < new Date(now.getTime() + 16 * 3600000));
    const kwh = todaySlots.reduce((acc, s) => acc + s.watts * 0.5 / 1000, 0);
    const good = todaySlots.filter(s => s.watts >= WINDOW_WATTS);
    if (good.length > 0) {
      const startStr = good[0].dt.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
      const endStr = new Date(good[good.length - 1].dt.getTime() + 30 * 60000).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
      const peak = Math.max(...good.map(s => s.watts));
      await sendPush(
        `☀️ Bilan Solaire : ${kwh.toFixed(1)} kWh prévus`,
        `Créneau ≥ ${WINDOW_WATTS} W de ${startStr} à ${endStr} (Pic estimé : ${peak} W).`,
        "sunny,bar_chart"
      );
    } else {
      await sendPush("☁️ Bilan Solaire : Journée couverte", `Production faible (${kwh.toFixed(1)} kWh), aucun créneau ≥ ${WINDOW_WATTS} W.`, "cloud");
    }
  }

  if (isWithinWindow(nowMinutes, REALTIME_WINDOW)) {
    const currentSlot = slots.find(s => s.dt >= now);
    const nextSlot = slots.find(s => s.dt >= new Date(now.getTime() + 30 * 60000));
    if (currentSlot && nextSlot && currentSlot.watts < PUSH_WATTS && nextSlot.watts >= PUSH_WATTS) {
      const timeStr = nextSlot.dt.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
      await sendPush(
        `⚡ Soleil imminent (${nextSlot.watts} W à ${timeStr})`,
        `La production va dépasser ${PUSH_WATTS} W dans 30 min.`,
        "zap,sunny"
      );
    }
  }
}

run();
        
