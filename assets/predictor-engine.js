(function (global) {
  "use strict";

  const DICE_COLORS = [
    { name: "Red", hex: "#FF0000", emoji: "🔴", rgb: "255, 0, 0" },
    { name: "Orange", hex: "#FFA500", emoji: "🟠", rgb: "255, 165, 0" },
    { name: "Yellow", hex: "#FFD700", emoji: "🟡", rgb: "255, 215, 0" },
    { name: "Green", hex: "#008000", emoji: "🟢", rgb: "0, 128, 0" },
    { name: "Blue", hex: "#0000FF", emoji: "🔵", rgb: "0, 0, 255" },
    { name: "Purple", hex: "#800080", emoji: "🟣", rgb: "128, 0, 128" }
  ];

  const COLOR_BY_NAME = {};
  const COLOR_BY_HEX = {};
  DICE_COLORS.forEach((c) => {
    COLOR_BY_NAME[c.name.toUpperCase()] = c;
    COLOR_BY_HEX[c.hex.toUpperCase()] = c;
  });

  function normalizeGameId(rawId) {
    return String(rawId || "")
      .trim()
      .toUpperCase()
      .replace(/^#+/, "")
      .replace(/[^A-Z0-9_-]/g, "");
  }

  // 128-bit string hash (cyrb128) for deterministic ID seeding
  function cyrb128(str) {
    let h1 = 1779033703,
      h2 = 3144134277,
      h3 = 1013904242,
      h4 = 2773480762;
    for (let i = 0, k; i < str.length; i++) {
      k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4;
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }

  // High-quality 32-bit PRNG (sfc32)
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0;
      b >>>= 0;
      c >>>= 0;
      d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function getForcedOverridesMap() {
    try {
      const raw = localStorage.getItem("offlinedice_forced_rolls_v1");
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveForcedOverride(gameId, rollNumber, colorNames) {
    const cleanId = normalizeGameId(gameId);
    if (!cleanId) return;
    try {
      const map = getForcedOverridesMap();
      if (!map[cleanId]) map[cleanId] = {};
      if (!colorNames || colorNames.length === 0) {
        delete map[cleanId][String(rollNumber)];
      } else {
        map[cleanId][String(rollNumber)] = colorNames;
      }
      localStorage.setItem("offlinedice_forced_rolls_v1", JSON.stringify(map));
    } catch (e) {}
  }

  function getForcedOverride(gameId, rollNumber) {
    const cleanId = normalizeGameId(gameId);
    if (!cleanId) return null;
    const map = getForcedOverridesMap();
    const entry = map[cleanId] && map[cleanId][String(rollNumber)];
    if (Array.isArray(entry) && entry.length > 0) {
      return entry
        .map((name) => COLOR_BY_NAME[String(name).toUpperCase()] || DICE_COLORS[0]);
    }
    return null;
  }

  function clearForcedOverrides(gameId) {
    const cleanId = normalizeGameId(gameId);
    if (!cleanId) return;
    try {
      const map = getForcedOverridesMap();
      delete map[cleanId];
      localStorage.setItem("offlinedice_forced_rolls_v1", JSON.stringify(map));
    } catch (e) {}
  }

  /**
   * Deterministically predicts the exact dice colors for a given (gameId, rollNumber, diceCount).
   * Both the Predictor UI and the Offline Dice Game use this exact function so predictions
   * match 100% before the roll button is pressed.
   */
  function predictRollById(gameId, rollNumber, diceCount, options = {}) {
    const cleanId = normalizeGameId(gameId) || "DEFAULT";
    const rollNum = Math.max(1, parseInt(rollNumber, 10) || 1);
    const count = Math.min(100, Math.max(1, parseInt(diceCount, 10) || 4));

    // Check if there is a forced/locked custom roll for this ID + rollNum
    const customOverride = options.customColors || getForcedOverride(cleanId, rollNum);

    const seedKey = `${cleanId}::OFFLINEDICE_PREDICTOR::ROLL_${rollNum}`;
    const seed = cyrb128(seedKey);
    const rand = sfc32(seed[0], seed[1], seed[2], seed[3]);

    // Warm up PRNG rounds
    for (let i = 0; i < 8; i++) rand();

    const dice = [];
    for (let d = 0; d < count; d++) {
      if (customOverride && customOverride[d]) {
        const c = customOverride[d];
        dice.push({
          dieNumber: d + 1,
          name: c.name,
          hex: c.hex,
          emoji: c.emoji,
          rgb: c.rgb
        });
      } else {
        const dieSeed = cyrb128(`${seedKey}::DIE_${d}::N_${count}`);
        const dieRand = sfc32(dieSeed[0] ^ seed[0], dieSeed[1] ^ seed[1], dieSeed[2], dieSeed[3]);
        dieRand();
        dieRand();
        const colorIndex = Math.floor(dieRand() * DICE_COLORS.length) % DICE_COLORS.length;
        const c = DICE_COLORS[colorIndex];
        dice.push({
          dieNumber: d + 1,
          name: c.name,
          hex: c.hex,
          emoji: c.emoji,
          rgb: c.rgb
        });
      }
    }

    const hashVal = ((seed[0] ^ seed[2]) >>> 0).toString(16).toUpperCase().padStart(8, "0");
    const hash = "0x" + hashVal;

    // Summarize color counts
    const counts = {};
    DICE_COLORS.forEach((c) => {
      counts[c.name] = 0;
    });
    dice.forEach((d) => {
      counts[d.name] = (counts[d.name] || 0) + 1;
    });

    let dominantColor = dice[0] ? dice[0].name : "Red";
    let maxCount = 0;
    Object.keys(counts).forEach((name) => {
      if (counts[name] > maxCount) {
        maxCount = counts[name];
        dominantColor = name;
      }
    });

    return {
      gameId: cleanId,
      rollNumber: rollNum,
      diceCount: count,
      dice: dice,
      colors: dice.map((d) => d.hex),
      names: dice.map((d) => d.name),
      hash: hash,
      counts: counts,
      dominantColor: dominantColor,
      dominantCount: maxCount,
      isCustomLocked: Boolean(customOverride)
    };
  }

  /**
   * Generates a lookahead queue of upcoming rolls (e.g., Next 5 Rolls: #N+1 to #N+5)
   */
  function predictUpcomingQueue(gameId, startRollNumber, diceCount, queueLength = 5) {
    const queue = [];
    const start = Math.max(1, parseInt(startRollNumber, 10) || 1);
    for (let i = 0; i < queueLength; i++) {
      queue.push(predictRollById(gameId, start + i, diceCount));
    }
    return queue;
  }

  // Web Audio synth for clean sound effects (works 100% offline without external mp3 files)
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playAlertPing(type = "predict") {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === "intercept") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.08); // A5
        osc.frequency.setValueAtTime(1174.66, now + 0.16); // D6
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
        osc.start(now);
        osc.stop(now + 0.38);
      } else {
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.07); // E5
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (e) {}
  }

  global.OfflineDicePredictor = {
    DICE_COLORS,
    COLOR_BY_NAME,
    COLOR_BY_HEX,
    normalizeGameId,
    predictRollById,
    predictUpcomingQueue,
    saveForcedOverride,
    getForcedOverride,
    clearForcedOverrides,
    playAlertPing
  };
})(window);
