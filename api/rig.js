const SUPABASE_URL = "https://iejditssxoknjpkfahxs.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImllamRpdHNzeG9rbmpwa2ZhaHhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxODc1MTEsImV4cCI6MjExMDc2MzUxMX0.Jt9XACLGe18RE1qb4HLMAog9Rwfv-NOAeNoJ2Amz3NI";

const DICE_PALETTE = [
  { name: "Red", hex: "#FF0000" },
  { name: "Orange", hex: "#FFA500" },
  { name: "Yellow", hex: "#FFD700" },
  { name: "Green", hex: "#008000" },
  { name: "Blue", hex: "#0000FF" },
  { name: "Purple", hex: "#800080" }
];

function normalizeId(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^#+/, "")
    .replace(/[^A-Z0-9_-]/g, "");
}

function mapNamesToColors(names) {
  return (names || []).map((nm) => {
    const s = String(nm || "").trim().toUpperCase();
    return (
      DICE_PALETTE.find(
        (c) => c.name.toUpperCase() === s || c.hex.toUpperCase() === s
      ) || DICE_PALETTE[0]
    );
  });
}

function generateRandomDice(count) {
  const dc = Math.min(100, Math.max(1, Number(count) || 4));
  const list = [];
  for (let i = 0; i < dc; i++) {
    const idx = Math.floor(Math.random() * DICE_PALETTE.length);
    list.push(DICE_PALETTE[idx]);
  }
  return {
    names: list.map((c) => c.name),
    colors: list.map((c) => c.hex)
  };
}

async function getSessionRow(sessionId) {
  const url = `${SUPABASE_URL}/rest/v1/dice_rig_sessions?session_id=eq.${encodeURIComponent(
    sessionId
  )}&select=*`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json"
    }
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function upsertSessionRow(payload) {
  const url = `${SUPABASE_URL}/rest/v1/dice_rig_sessions?on_conflict=session_id`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) return payload;
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : payload;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (_e) {
        body = {};
      }
    }

    const action =
      req.query?.action ||
      body.action ||
      (req.query?.consume === "1" ? "consume" : "status");

    if (action === "latest_pc") {
      const latestPointer = await getSessionRow("__LATEST_PC__");
      const latestId =
        latestPointer &&
        Array.isArray(latestPointer.predicted_names) &&
        latestPointer.predicted_names[0]
          ? latestPointer.predicted_names[0]
          : "";
      let sessionData = null;
      if (latestId) {
        sessionData = await getSessionRow(latestId);
      }
      return res.status(200).json({
        ok: true,
        latestPcSessionId: latestId,
        updatedAt: latestPointer ? latestPointer.updated_at : 0,
        session: sessionData
      });
    }

    const rawId =
      req.query?.sessionId || req.query?.id || body.sessionId || body.id || "";
    const sessionId = normalizeId(rawId);

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing sessionId"
      });
    }

    const source = req.query?.source || body.source || "";
    if (source === "pc" && sessionId !== "__LATEST_PC__") {
      upsertSessionRow({
        session_id: "__LATEST_PC__",
        locked_names: [],
        locked_colors: [],
        predicted_names: [sessionId],
        predicted_colors: [],
        is_locked: false,
        persist_every_roll: false,
        roll_number: 1,
        updated_at: Date.now()
      }).catch(() => {});
    }

    const diceCount = Math.min(
      100,
      Math.max(
        1,
        parseInt(req.query?.diceCount || body.diceCount || 4, 10) || 4
      )
    );

    let existing = await getSessionRow(sessionId);

    if (action === "lock") {
      const queryColors = req.query?.colors
        ? String(req.query.colors).split(",")
        : null;
      const inputNames = queryColors
        ? queryColors
        : Array.isArray(body.lockedNames)
        ? body.lockedNames
        : Array.isArray(body.names)
        ? body.names
        : ["Red", "Red", "Red", "Red"];
      const mapped = mapNamesToColors(inputNames);
      const names = mapped.map((c) => c.name);
      const colors = mapped.map((c) => c.hex);
      const persistParam = req.query?.persist;
      const persist =
        persistParam !== undefined
          ? persistParam === "1" || persistParam === "true"
          : body.persistEveryRoll !== undefined
          ? Boolean(body.persistEveryRoll)
          : existing
          ? Boolean(existing.persist_every_roll)
          : false;

      const updated = await upsertSessionRow({
        session_id: sessionId,
        locked_names: names,
        locked_colors: colors,
        predicted_names: names,
        predicted_colors: colors,
        is_locked: true,
        persist_every_roll: persist,
        roll_number: existing ? existing.roll_number || 1 : 1,
        updated_at: Date.now()
      });

      return res.status(200).json({
        ok: true,
        sessionId,
        mode: "LOCKED",
        activeNames: names,
        activeColors: colors,
        state: updated
      });
    }

    if (action === "reroll" || action === "predict") {
      const queryColors = req.query?.colors
        ? String(req.query.colors).split(",")
        : null;
      const customNames = queryColors
        ? queryColors
        : Array.isArray(body.predictedNames)
        ? body.predictedNames
        : null;
      const gen = customNames
        ? {
            names: mapNamesToColors(customNames).map((c) => c.name),
            colors: mapNamesToColors(customNames).map((c) => c.hex)
          }
        : generateRandomDice(diceCount);

      const updated = await upsertSessionRow({
        session_id: sessionId,
        locked_names: [],
        locked_colors: [],
        predicted_names: gen.names,
        predicted_colors: gen.colors,
        is_locked: false,
        persist_every_roll: false,
        roll_number: existing ? existing.roll_number || 1 : 1,
        updated_at: Date.now()
      });

      return res.status(200).json({
        ok: true,
        sessionId,
        mode: "PREDICTED",
        activeNames: gen.names,
        activeColors: gen.colors,
        state: updated
      });
    }

    if (action === "consume") {
      if (!existing) {
        const firstGen = generateRandomDice(diceCount);
        existing = await upsertSessionRow({
          session_id: sessionId,
          locked_names: [],
          locked_colors: [],
          predicted_names: firstGen.names,
          predicted_colors: firstGen.colors,
          is_locked: false,
          persist_every_roll: false,
          roll_number: 1,
          updated_at: Date.now()
        });
      }

      const useLocked =
        existing.is_locked &&
        Array.isArray(existing.locked_names) &&
        existing.locked_names.length > 0;
      const rawToLand = useLocked
        ? existing.locked_names
        : Array.isArray(existing.predicted_names) &&
          existing.predicted_names.length > 0
        ? existing.predicted_names
        : generateRandomDice(diceCount).names;

      const mappedToLand = mapNamesToColors(rawToLand);
      const finalToLand = [];
      for (let i = 0; i < diceCount; i++) {
        finalToLand.push(mappedToLand[i % mappedToLand.length]);
      }

      const nextRollNum = (existing.roll_number || 1) + 1;
      const keepLocked = Boolean(existing.is_locked && existing.persist_every_roll);
      const nextGen = keepLocked
        ? {
            names: existing.locked_names,
            colors: existing.locked_colors
          }
        : generateRandomDice(diceCount);

      const nextState = await upsertSessionRow({
        session_id: sessionId,
        locked_names: keepLocked ? existing.locked_names : [],
        locked_colors: keepLocked ? existing.locked_colors : [],
        predicted_names: nextGen.names,
        predicted_colors: nextGen.colors,
        is_locked: keepLocked,
        persist_every_roll: keepLocked,
        roll_number: nextRollNum,
        updated_at: Date.now()
      });

      return res.status(200).json({
        ok: true,
        sessionId,
        wasLocked: useLocked,
        rollNumber: existing.roll_number || 1,
        rollToLandNames: finalToLand.map((c) => c.name),
        rollToLandColors: finalToLand.map((c) => c.hex),
        nextState
      });
    }

    if (
      !existing ||
      !Array.isArray(existing.predicted_names) ||
      existing.predicted_names.length === 0
    ) {
      const initGen = generateRandomDice(diceCount);
      existing = await upsertSessionRow({
        session_id: sessionId,
        locked_names: [],
        locked_colors: [],
        predicted_names: initGen.names,
        predicted_colors: initGen.colors,
        is_locked: false,
        persist_every_roll: false,
        roll_number: 1,
        updated_at: Date.now()
      });
    }

    const isLocked =
      Boolean(existing.is_locked) &&
      Array.isArray(existing.locked_names) &&
      existing.locked_names.length > 0;
    const activeNames = isLocked
      ? existing.locked_names
      : existing.predicted_names;
    const activeColors = isLocked
      ? existing.locked_colors
      : existing.predicted_colors;

    return res.status(200).json({
      ok: true,
      sessionId,
      mode: isLocked ? "LOCKED" : "PREDICTED",
      activeNames,
      activeColors,
      state: existing
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}
