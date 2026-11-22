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

  function randomHexHash() {
    const arr = new Uint8Array(4);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < 4; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return (
      "0x" +
      Array.from(arr)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    );
  }

  /**
   * Generates a real CSPRNG roll (used to pre-queue the exact next roll into Firebase
   * sessions/<ID>/next_roll before the player clicks Roll).
   */
  function generateRealCsprngRoll(gameId, rollNumber, diceCount, customColorNames = null) {
    const cleanId = normalizeGameId(gameId) || "SESSION";
    const rollNum = Math.max(1, parseInt(rollNumber, 10) || 1);
    const count = Math.min(100, Math.max(1, parseInt(diceCount, 10) || 4));

    const names = [];
    if (Array.isArray(customColorNames) && customColorNames.length > 0) {
      for (let i = 0; i < count; i++) {
        const c = COLOR_BY_NAME[String(customColorNames[i % customColorNames.length]).toUpperCase()] || DICE_COLORS[0];
        names.push(c.name);
      }
    } else {
      const randBuf = new Uint32Array(count);
      if (global.crypto && global.crypto.getRandomValues) {
        global.crypto.getRandomValues(randBuf);
      } else {
        for (let i = 0; i < count; i++) randBuf[i] = Math.floor(Math.random() * 6);
      }
      for (let i = 0; i < count; i++) {
        const c = DICE_COLORS[randBuf[i] % DICE_COLORS.length];
        names.push(c.name);
      }
    }

    return buildRollObject(cleanId, rollNum, names, randomHexHash(), Date.now(), Boolean(customColorNames));
  }

  /**
   * Builds a rich roll object from exact Firebase color names or hexes.
   */
  function buildRollObject(gameId, rollNumber, colorNamesOrHexes, hash, timestamp, isCustomLocked = false) {
    const cleanId = normalizeGameId(gameId);
    const rollNum = Math.max(1, parseInt(rollNumber, 10) || 1);
    const rawList = Array.isArray(colorNamesOrHexes) ? colorNamesOrHexes : [];

    const dice = rawList.map((item, idx) => {
      const key = String(item || "").trim().toUpperCase();
      const c = COLOR_BY_NAME[key] || COLOR_BY_HEX[key] || DICE_COLORS[0];
      return {
        dieNumber: idx + 1,
        name: c.name,
        hex: c.hex,
        emoji: c.emoji,
        rgb: c.rgb
      };
    });

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
      diceCount: dice.length,
      dice: dice,
      colors: dice.map((d) => d.hex),
      names: dice.map((d) => d.name),
      hash: hash || randomHexHash(),
      time: timestamp || Date.now(),
      counts: counts,
      dominantColor: dominantColor,
      dominantCount: maxCount,
      isCustomLocked: Boolean(isCustomLocked)
    };
  }

  // Web Audio synth for clean instant notifications
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

  function playAlertPing(type = "intercept") {
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
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.07);
        osc.frequency.setValueAtTime(1174.66, now + 0.14);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } else {
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.06);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      }
    } catch (e) {}
  }

  global.OfflineDicePredictor = {
    DICE_COLORS,
    COLOR_BY_NAME,
    COLOR_BY_HEX,
    normalizeGameId,
    randomHexHash,
    generateRealCsprngRoll,
    buildRollObject,
    playAlertPing
  };
})(window);
