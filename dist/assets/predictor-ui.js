(function () {
  "use strict";

  const Predictor = window.OfflineDicePredictor;
  if (!Predictor) return;

  const RIG_API_ENDPOINTS = [
    "https://offlinedicerdd.vercel.app/api/rig",
    "/api/rig",
    "https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig"
  ];

  let currentMode = "predictor"; // 'predictor' | 'game' | 'split'
  let activeId = "";
  let currentDiceCount = 4;
  let autoDetectDiceCount = true;
  let loggedRollsCount = 0;
  let onScreenRollsCount = 0;
  let soundAlertEnabled = true;
  let sessionHistory = [];
  let firebaseNextRoll = null; // Exact pre-fetched or locked roll before click
  let isCurrentlyRollingOnScreen = false;
  let firebaseListeners = [];
  let customDraftColors = [];
  let selectedHistoryRoll = null;
  let v110ActiveOption = 1; // 1 = Predict Next Dice Before Roll, 2 = Choose Color First
  let v110PersistEveryRoll = false; // false = Next Roll Only, true = Auto-Lock Every Roll
  let v110LockedColors = []; // Active locked colors from Option 2
  let apiPollTimer = null;
  let lastSeenApiRollNum = 0;
  let apiRequestInFlight = false;

  async function callRigApi(payload) {
    const clean = Predictor.normalizeGameId(payload.sessionId || activeId);
    if (!clean) return null;
    const reqBody = Object.assign(
      {
        sessionId: clean,
        diceCount: currentDiceCount,
        action: "status"
      },
      payload,
      { sessionId: clean }
    );

    // Try endpoints in order: local /api/rig if on same origin, then offlinedicerdd.vercel.app/api/rig, then Supabase edge function
    const orderedEndpoints =
      window.location && window.location.hostname === "offlinedicerdd.vercel.app"
        ? ["/api/rig", "https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig"]
        : [
            "https://offlinedicerdd.vercel.app/api/rig",
            "https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig",
            "/api/rig"
          ];

    for (let i = 0; i < orderedEndpoints.length; i++) {
      try {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tId = ctrl ? setTimeout(() => ctrl.abort(), 3000) : null;
        const url =
          orderedEndpoints[i] +
          "?sessionId=" +
          encodeURIComponent(clean) +
          "&action=" +
          encodeURIComponent(reqBody.action) +
          "&diceCount=" +
          encodeURIComponent(reqBody.diceCount || 4) +
          "&_t=" +
          Date.now();
        const resp = await fetch(url, {
          method: "POST",
          mode: "cors",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
          signal: ctrl ? ctrl.signal : undefined
        });
        if (tId) clearTimeout(tId);
        if (resp && resp.ok) {
          const contentType = resp.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await resp.json();
            if (data && data.ok) return data;
          }
        }
      } catch (err) {}
    }
    return null;
  }

  function applyApiDataToPredictorState(cleanId, apiData, notifyOnNewRoll) {
    if (!apiData || !apiData.ok) return;
    const st = apiData.state || {};
    const rollNum = Math.max(1, Number(st.roll_number) || 1);
    const isLocked = apiData.mode === "LOCKED" || Boolean(st.is_locked);
    const activeNames =
      Array.isArray(apiData.activeNames) && apiData.activeNames.length > 0
        ? apiData.activeNames
        : Array.isArray(st.predicted_names) && st.predicted_names.length > 0
        ? st.predicted_names
        : ["Red", "Orange", "Yellow", "Green"];

    if (autoDetectDiceCount && activeNames.length > 0 && activeNames.length !== currentDiceCount) {
      currentDiceCount = activeNames.length;
      const sel = document.getElementById("predictorDiceCountSelect");
      if (sel) sel.value = String(currentDiceCount);
    }

    const builtRoll = Predictor.buildRollObject(
      cleanId,
      rollNum,
      activeNames,
      "API-" + (st.updated_at || Date.now()),
      st.updated_at || Date.now(),
      isLocked
    );
    builtRoll.rollId = "api_roll_" + rollNum;
    builtRoll.isCustomLocked = isLocked;
    builtRoll.timestamp = new Date(st.updated_at || Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });

    const isRollAdvance = lastSeenApiRollNum > 0 && rollNum > lastSeenApiRollNum;
    lastSeenApiRollNum = rollNum;
    loggedRollsCount = rollNum;
    onScreenRollsCount = Math.max(0, rollNum - 1);
    firebaseNextRoll = builtRoll;

    // Keep sessionHistory updated with the latest active roll at the end
    const existingIdx = sessionHistory.findIndex((r) => r.rollNumber === rollNum);
    if (existingIdx >= 0) {
      sessionHistory[existingIdx] = builtRoll;
    } else {
      sessionHistory.push(builtRoll);
      if (sessionHistory.length > 25) sessionHistory.shift();
    }

    const connBadge = document.getElementById("predConnectionBadge");
    if (connBadge) {
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> API SYNC ACTIVE (#${cleanId} • ${
        isLocked ? "🔒 LOCKED" : "🔮 PREDICTED"
      })`;
    }

    const statusEl = document.getElementById("v110LiveLockStatus");
    if (statusEl) {
      if (isLocked) {
        statusEl.innerHTML = `✅ API LOCKED FOR <strong>#${cleanId}</strong> (ROLL #${rollNum}): <span style="color:#FFEA3D;">${activeNames
          .join(" • ")
          .toUpperCase()}</span> — CLICK "ROLL AGAIN !" ON OFFLINE-DICE.COM NOW!`;
      } else {
        statusEl.innerHTML = `🔮 NEXT ROLL #${rollNum} FOR <strong>#${cleanId}</strong>: <span style="color:#4ADE80;">${activeNames
          .join(" • ")
          .toUpperCase()}</span> (TAP ANY COLOR ABOVE TO LOCK CUSTOM COLORS)`;
      }
    }

    if (notifyOnNewRoll && isRollAdvance) {
      isCurrentlyRollingOnScreen = false;
      selectedHistoryRoll = null;
      triggerInterceptBanner(
        `🎲 ROLL #${rollNum - 1} LANDED ON OFFLINE-DICE.COM! NEXT ROLL #${rollNum} READY: ${activeNames
          .join(" • ")
          .toUpperCase()}`
      );
      if (soundAlertEnabled) {
        Predictor.playAlertPing("intercept");
      }
    }

    renderAllPredictorViews();
  }

  function getDb() {
    if (window.firebaseDbInstance) return window.firebaseDbInstance;
    try {
      if (window.firebase && window.firebase.apps && window.firebase.apps.length > 0) {
        return window.firebase.database(
          window.firebase.apps[0],
          "https://offline-dice-verify-default-rtdb.europe-west1.firebasedatabase.app"
        );
      }
    } catch (e) {}
    return null;
  }

  function detachFirebaseListeners() {
    firebaseListeners.forEach((item) => {
      try {
        item.ref.off(item.event, item.cb);
      } catch (e) {}
    });
    firebaseListeners = [];
    if (apiPollTimer) {
      clearInterval(apiPollTimer);
      apiPollTimer = null;
    }
  }

  async function syncSessionWithRigApi(cleanId, notifyOnNewRoll) {
    if (!cleanId || apiRequestInFlight) return;
    apiRequestInFlight = true;
    try {
      const apiData = await callRigApi({
        action: "status",
        sessionId: cleanId,
        diceCount: currentDiceCount
      });
      if (apiData && apiData.ok && Predictor.normalizeGameId(activeId) === cleanId) {
        applyApiDataToPredictorState(cleanId, apiData, notifyOnNewRoll);
      }
    } finally {
      apiRequestInFlight = false;
    }
  }

  function connectSessionToFirebase(cleanId) {
    detachFirebaseListeners();
    if (!cleanId) return;

    const connBadge = document.getElementById("predConnectionBadge");
    if (connBadge) {
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> CONNECTING TO /api/rig (#${cleanId})...`;
    }

    lastSeenApiRollNum = 0;
    syncSessionWithRigApi(cleanId, false);

    // Poll /api/rig every 1.2s so rolls on PC or locks on Mobile stay in real-time sync
    apiPollTimer = setInterval(() => {
      const curClean = Predictor.normalizeGameId(activeId);
      if (curClean === cleanId) {
        syncSessionWithRigApi(cleanId, true);
      }
    }, 1200);

    // Also attach read-only Firebase listener for historical rolls if available
    const db = getDb();
    if (db) {
      const rollsRef = db.ref("sessions/" + cleanId + "/rolls");
      const onRolls = (snap) => {
        if (!snap.exists()) return;
        const fbRolls = [];
        let idx = 1;
        snap.forEach((childSnap) => {
          const data = childSnap.val() || {};
          const t = data.time ? new Date(data.time) : new Date();
          const timeStr = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          let names = Array.isArray(data.names) ? data.names : [];
          if (names.length === 0 && Array.isArray(data.colors)) {
            names = data.colors.map((hex) => {
              const c = Predictor.COLOR_BY_HEX[String(hex).toUpperCase()];
              return c ? c.name : "Red";
            });
          }
          if (names.length > 0) {
            const built = Predictor.buildRollObject(
              cleanId,
              data.rollNumber || idx,
              names,
              data.hash || "",
              data.time || Date.now(),
              false
            );
            built.key = childSnap.key;
            built.rollId = childSnap.key;
            built.timestamp = timeStr;
            fbRolls.push(built);
            idx++;
          }
        });
        if (fbRolls.length > 0 && firebaseNextRoll) {
          sessionHistory = [...fbRolls, firebaseNextRoll];
          renderAllPredictorViews();
        }
      };
      rollsRef.on("value", onRolls);
      firebaseListeners.push({ ref: rollsRef, event: "value", cb: onRolls });
    }
  }

  let interceptTimeout = null;
  function triggerInterceptBanner(message) {
    const banner = document.getElementById("predInterceptBanner");
    const stage = document.getElementById("predStageCard");
    if (banner) {
      banner.textContent = message;
      banner.classList.add("show");
    }
    if (stage) {
      stage.classList.add("intercept-flash");
    }
    if (interceptTimeout) clearTimeout(interceptTimeout);
    interceptTimeout = setTimeout(() => {
      if (banner) banner.classList.remove("show");
      if (stage) stage.classList.remove("intercept-flash");
    }, 5000);
  }

  function getActiveFirebaseRollToDisplay() {
    if (selectedHistoryRoll) {
      return {
        roll: selectedHistoryRoll,
        onScreenRoll: sessionHistory.length >= 2 ? sessionHistory[sessionHistory.length - 2] : null,
        mode: "HISTORY_INSPECT"
      };
    }

    if (firebaseNextRoll && firebaseNextRoll.dice && firebaseNextRoll.dice.length > 0) {
      const prevOnScreen = sessionHistory.length >= 2 ? sessionHistory[sessionHistory.length - 2] : null;
      return {
        roll: firebaseNextRoll,
        onScreenRoll: prevOnScreen,
        mode: isCurrentlyRollingOnScreen ? "LIVE_ROLLING_NOW" : "PRE_CLICK_READY"
      };
    }

    if (sessionHistory.length > 0) {
      const latestBuffered = sessionHistory[sessionHistory.length - 1];
      const prevOnScreen = sessionHistory.length >= 2 ? sessionHistory[sessionHistory.length - 2] : null;
      return {
        roll: latestBuffered,
        onScreenRoll: prevOnScreen,
        mode: isCurrentlyRollingOnScreen ? "LIVE_ROLLING_NOW" : "PRE_CLICK_READY"
      };
    }

    return { roll: null, onScreenRoll: null, mode: "FETCHING_PRE_CLICK" };
  }

  function renderAllPredictorViews() {
    const cleanId = Predictor.normalizeGameId(activeId) || "READY";
    const displayState = getActiveFirebaseRollToDisplay();
    const activeRoll = displayState.roll;
    const onScreenRoll = displayState.onScreenRoll;

    const elId = document.getElementById("telActiveId");
    const elLogged = document.getElementById("telRollsLogged");
    const elTarget = document.getElementById("telTargetRoll");
    const elDiceCount = document.getElementById("telDiceCount");

    if (elId) elId.textContent = "#" + cleanId;
    if (elLogged) {
      elLogged.textContent = `${onScreenRollsCount} Landed / Roll #${Math.max(1, loggedRollsCount)}`;
    }
    if (elTarget) {
      if (displayState.mode === "PRE_CLICK_READY" && activeRoll) {
        elTarget.textContent = `NEXT ROLL #${activeRoll.rollNumber} (${
          activeRoll.isCustomLocked ? "🔒 LOCKED" : "BEFORE CLICK"
        })`;
      } else if (displayState.mode === "LIVE_ROLLING_NOW" && activeRoll) {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (LANDING NOW!)`;
      } else if (displayState.mode === "HISTORY_INSPECT" && activeRoll) {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (INSPECT)`;
      } else {
        elTarget.textContent = `CONNECTING API...`;
      }
    }
    if (elDiceCount) {
      const dc = activeRoll ? activeRoll.diceCount : currentDiceCount;
      elDiceCount.textContent = `${dc} DICE`;
    }

    const stageBadge = document.getElementById("predStageRollBadge");
    const hashBadge = document.getElementById("predStageHash");
    const diceShowcase = document.getElementById("predDiceShowcase");
    const seqBar = document.getElementById("predSequenceText");
    const breakdownGrid = document.getElementById("predColorBreakdown");

    if (!activeRoll) {
      if (stageBadge) {
        stageBadge.innerHTML = `📡 SYNCING WITH /api/rig FOR #${cleanId}...`;
      }
      if (hashBadge) {
        hashBadge.textContent = `DEDICATED RIG API (offlinedicerdd.vercel.app/api/rig) • STEALTH MODE`;
      }
      if (diceShowcase) {
        diceShowcase.innerHTML = `
          <div style="text-align:left; padding: 14px 18px; max-width: 600px; background: rgba(0,0,0,0.45); border: 1px solid rgba(255,234,61,0.35); border-radius: 14px;">
            <div style="font-size: 15px; font-weight: 800; color: #FFEA3D; margin-bottom: 8px; text-align:center;">
              🚀 1-Click API Sync for <span style="color:#00D2FF;">offline-dice.com</span> (Zero Rig UI on Game):
            </div>
            <ol style="font-size: 12.5px; color: rgba(255,255,255,0.88); line-height: 1.6; margin: 0 0 12px 18px; padding: 0;">
              <li><strong>Option A (100% Automatic Every Time):</strong> Install <strong>Tampermonkey</strong> once, then click <strong>🚀 1-Click Auto-Install Script</strong> below. It connects <code>offline-dice.com</code> directly to <code>https://offlinedicerdd.vercel.app/api/rig</code>!</li>
              <li><strong>Option B (1-Click Bookmark — No Extension):</strong> Drag the <strong>🎲 Sync Offline-Dice</strong> button at the top onto your Bookmarks Bar, then click it once when on <code>offline-dice.com</code>.</li>
            </ol>
            <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
              <a href="/offline-dice.user.js" target="_blank" class="predictor-mini-btn" style="background:linear-gradient(135deg,#FFEA3D,#F59E0B); color:#000; border-color:#FFEA3D; padding:8px 14px; font-size:13px; font-weight:800; text-decoration:none;">
                🚀 1-Click Auto-Install Script (.user.js)
              </a>
              <button class="predictor-mini-btn" style="border-color:#00D2FF; color:#00D2FF; padding:8px 14px; font-size:12.5px;" onclick="copyExternalSitePreClickHook()">
                📋 Copy Silent API Script
              </button>
            </div>
          </div>
        `;
      }
      if (seqBar) {
        seqBar.innerHTML = `<span style="color:rgba(255,255,255,0.75);">Connected to <strong>https://offlinedicerdd.vercel.app/api/rig</strong> for Session <strong>#${cleanId}</strong>!</span>`;
      }
      if (breakdownGrid) {
        breakdownGrid.innerHTML = "";
      }
    } else {
      if (stageBadge) {
        if (displayState.mode === "PRE_CLICK_READY") {
          stageBadge.innerHTML = `${
            activeRoll.isCustomLocked
              ? `🔒 API LOCKED CUSTOM DICE — NEXT ROLL #${activeRoll.rollNumber} WILL LAND ON THESE EXACT COLORS`
              : `🔮 PREDICTED BEFORE YOU CLICK — NEXT ROLL #${activeRoll.rollNumber} (100% SYNCED VIA /api/rig)`
          }`;
        } else if (displayState.mode === "LIVE_ROLLING_NOW") {
          stageBadge.innerHTML = `🎲 ROLLING NOW ON SCREEN — LANDING ON EXACT API DICE (#${activeRoll.rollNumber})!`;
        } else {
          stageBadge.innerHTML = `🔍 INSPECTING ROLL #${activeRoll.rollNumber}`;
        }
      }
      if (hashBadge) {
        hashBadge.textContent = `SYNCED WITH OFFLINE-DICE.COM VIA /api/rig • MODE: ${
          activeRoll.isCustomLocked ? "LOCKED CUSTOM COLORS" : "LIVE PREDICTION"
        }`;
      }

      if (diceShowcase) {
        diceShowcase.innerHTML = "";
        const frag = document.createDocumentFragment();
        activeRoll.dice.forEach((die) => {
          const card = document.createElement("div");
          card.className = "pred-die-card";
          card.innerHTML = `
            <div class="pred-die-index">DIE #${die.dieNumber}</div>
            <div class="pred-die-visual" style="background-color: ${die.hex};">
              <div class="pred-die-dot"></div>
            </div>
            <div class="pred-die-name" style="color: ${die.hex};">${die.name}</div>
          `;
          frag.appendChild(card);
        });
        diceShowcase.appendChild(frag);
      }

      if (seqBar) {
        const seqHtml = activeRoll.dice
          .slice(0, 16)
          .map(
            (d) =>
              `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.55);padding:3px 8px;border-radius:6px;border:1px solid ${d.hex};"><strong style="color:rgba(255,255,255,0.65);">#${d.dieNumber}:</strong> <strong style="color:${d.hex};">${d.name.toUpperCase()}</strong></span>`
          )
          .join(" ");
        const moreTxt =
          activeRoll.dice.length > 16 ? ` <span style="color:#aaa;">+${activeRoll.dice.length - 16} more</span>` : "";

        const onScreenStripHtml = onScreenRoll
          ? `<div style="width:100%;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;">
               <span style="color:#4ADE80;font-weight:800;">✅ PREVIOUS ROLL (#${onScreenRoll.rollNumber}): <strong style="color:#FFF;">${onScreenRoll.names.join(" • ").toUpperCase()}</strong></span>
               <span style="color:#FFEA3D;font-weight:800;">👆 ABOVE = EXACT DICE WHEN YOU CLICK "ROLL AGAIN !" ON OFFLINE-DICE.COM</span>
             </div>`
          : `<div style="width:100%;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;">
               <span style="color:#4ADE80;font-weight:800;">✅ API SYNC READY (/api/rig): These exact dice will land on your next click of "ROLL AGAIN !" on offline-dice.com</span>
             </div>`;

        seqBar.innerHTML = `
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;justify-content:space-between;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              <span style="color:#FFEA3D;font-weight:800;margin-right:4px;">${
                activeRoll.isCustomLocked ? "🔒 LOCKED NEXT DICE:" : "🔮 NEXT DICE (BEFORE CLICK):"
              }</span>
              ${seqHtml}${moreTxt}
            </div>
            <div style="color:#00D2FF;font-weight:800;font-size:12.5px;">
              DOMINANT: <span style="color:#FFF;">${activeRoll.dominantColor.toUpperCase()} (${activeRoll.dominantCount}/${activeRoll.diceCount})</span>
            </div>
          </div>
          ${onScreenStripHtml}
        `;
      }

      if (breakdownGrid) {
        breakdownGrid.innerHTML = "";
        Predictor.DICE_COLORS.forEach((c) => {
          const count = activeRoll.counts[c.name] || 0;
          const pct = Math.round((count / activeRoll.diceCount) * 100);
          const chip = document.createElement("div");
          chip.className = "color-stat-chip" + (count > 0 ? " has-count" : "");
          if (count > 0) {
            chip.style.borderColor = c.hex;
          }
          chip.innerHTML = `
            <div class="color-stat-dot" style="background-color: ${c.hex};"></div>
            <div class="color-stat-name" style="color: ${c.hex};">${c.name}</div>
            <div class="color-stat-count">${count}x <span style="font-size:11px;color:rgba(255,255,255,0.65);">(${pct}%)</span></div>
          `;
          breakdownGrid.appendChild(chip);
        });
      }
    }

    renderFirebaseQueueAndRecentSection(cleanId, activeRoll);
    renderCustomLockerSlots(activeRoll);
    renderSessionHistoryFeed(cleanId);
  }

  function renderFirebaseQueueAndRecentSection(cleanId) {
    const queueList = document.getElementById("predUpcomingQueueList");
    if (!queueList) return;
    queueList.innerHTML = "";

    const recentRolls = [...sessionHistory].reverse().slice(0, 5);
    recentRolls.forEach((r, idx) => {
      const isPreClickNext = idx === 0;
      const isCurrentOnScreen = idx === 1;
      const item = document.createElement("div");
      item.className = "upcoming-roll-item" + (isPreClickNext ? " is-next" : "");
      item.onclick = () => {
        selectedHistoryRoll = isPreClickNext ? null : r;
        renderAllPredictorViews();
      };
      const diceBoxes = r.dice
        .slice(0, 14)
        .map(
          (d) => `
          <div class="upcoming-die-box" style="background-color: ${d.hex};" title="Die #${d.dieNumber}: ${d.name}">
            <div class="upcoming-die-dot"></div>
          </div>`
        )
        .join("");

      let badgeHtml = "";
      if (isPreClickNext) {
        badgeHtml = `<span style="background:${
          r.isCustomLocked ? "#FFEA3D" : "#22C55E"
        };color:#000;font-size:10px;font-weight:900;padding:2px 6px;border-radius:4px;text-transform:uppercase;">${
          r.isCustomLocked ? "🔒 API LOCKED NEXT ROLL" : "🔮 NEXT DICE (BEFORE YOU CLICK)"
        }</span>`;
      } else if (isCurrentOnScreen) {
        badgeHtml = `<span style="background:rgba(0,210,255,0.22);color:#00D2FF;font-size:10px;font-weight:800;padding:2px 6px;border-radius:4px;">✅ CURRENTLY ON SCREEN</span>`;
      } else {
        badgeHtml = `<span style="font-size:11px;color:rgba(255,255,255,0.5);">${r.timestamp || ""}</span>`;
      }

      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong style="font-size:13.5px;color:${isPreClickNext ? "#FFEA3D" : "#00D2FF"};">ROLL #${r.rollNumber}</strong>
          ${badgeHtml}
        </div>
        <div class="upcoming-mini-dice">${diceBoxes}</div>
        <div style="font-size:12px;color:#FFFFFF;font-weight:800;">
          ${r.names.slice(0, 6).join(" • ")}
        </div>
      `;
      queueList.appendChild(item);
    });

    if (queueList.children.length === 0) {
      queueList.innerHTML = `
        <div style="padding:12px;text-align:center;color:rgba(255,255,255,0.6);font-size:12.5px;">
          Syncing session <strong>#${cleanId}</strong> with <code>/api/rig</code>...
        </div>
      `;
    }
  }

  function renderCustomLockerSlots(activeRoll) {
    const slotCount = Math.min(12, currentDiceCount);
    if (customDraftColors.length !== slotCount) {
      if (activeRoll && activeRoll.dice && activeRoll.dice.length > 0) {
        customDraftColors = [];
        for (let i = 0; i < slotCount; i++) {
          customDraftColors.push(activeRoll.dice[i % activeRoll.dice.length].name);
        }
      } else {
        customDraftColors = Array(slotCount).fill("Red");
      }
    }

    const rollNumSpan = document.getElementById("lockerTargetRollLabel");
    if (rollNumSpan) rollNumSpan.textContent = `Next Roll #${Math.max(1, loggedRollsCount)}`;

    const container = document.getElementById("lockerDiceSlots");
    if (container) {
      container.innerHTML = "";
      customDraftColors.forEach((colName, idx) => {
        const c = Predictor.COLOR_BY_NAME[colName.toUpperCase()] || Predictor.DICE_COLORS[0];
        const slot = document.createElement("div");
        slot.className = "locker-die-slot";
        slot.title = "Click to cycle die color";
        slot.onclick = () => {
          const curIdx = Predictor.DICE_COLORS.findIndex((x) => x.name === c.name);
          const nextColor = Predictor.DICE_COLORS[(curIdx + 1) % Predictor.DICE_COLORS.length];
          customDraftColors[idx] = nextColor.name;
          renderCustomLockerSlots(activeRoll);
        };
        slot.innerHTML = `
          <span style="font-size:10px;color:rgba(255,255,255,0.65);font-weight:800;">#${idx + 1}</span>
          <div class="upcoming-die-box" style="width:34px;height:34px;border-radius:8px;background-color:${c.hex};">
            <div class="upcoming-die-dot" style="width:8px;height:8px;"></div>
          </div>
          <span style="font-size:11px;font-weight:800;color:${c.hex};">${c.name}</span>
        `;
        container.appendChild(slot);
      });
    }

    const v110Grid = document.getElementById("v110CustomDiePickerGrid");
    if (v110Grid) {
      v110Grid.innerHTML = "";
      customDraftColors.forEach((colName, idx) => {
        const c = Predictor.COLOR_BY_NAME[colName.toUpperCase()] || Predictor.DICE_COLORS[0];
        const card = document.createElement("div");
        card.className = "v110-die-picker-card";
        card.style.borderColor = c.hex;

        const swatchesHtml = Predictor.DICE_COLORS.map((sc) => {
          const isAct = sc.name.toUpperCase() === c.name.toUpperCase() ? "active" : "";
          return `<button type="button" class="v110-swatch-btn ${isAct}" style="background:${sc.hex};" onclick="setV110SingleDieColor(${idx}, '${sc.name}')" title="Set Die #${idx + 1} to ${sc.name}">${sc.name.charAt(0)}</button>`;
        }).join("");

        card.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
            <span style="font-size:11px; font-weight:800; color:rgba(255,255,255,0.75);">DIE #${idx + 1}</span>
            <strong style="font-family:'Fredoka',sans-serif; font-size:12.5px; color:${c.hex};">${c.name.toUpperCase()}</strong>
          </div>
          <div style="width:46px; height:46px; border-radius:11px; background:${c.hex}; border:2.5px solid #fff; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
            <div style="width:11px; height:11px; border-radius:50%; background:#fff;"></div>
          </div>
          <div class="v110-color-swatches">
            ${swatchesHtml}
          </div>
        `;
        v110Grid.appendChild(card);
      });
    }
  }

  function renderSessionHistoryFeed(cleanId) {
    const listEl = document.getElementById("predSessionHistoryList");
    const countBadge = document.getElementById("predHistoryCountBadge");
    if (countBadge) countBadge.textContent = `${sessionHistory.length} Rolls`;
    if (!listEl) return;

    if (sessionHistory.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 18px; text-align: center; color: rgba(255,255,255,0.6); font-size: 13px; background: rgba(0,0,0,0.35); border-radius: 10px;">
          Connecting session <strong>#${cleanId}</strong> to <code>/api/rig</code>...
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    const reversed = [...sessionHistory].reverse().slice(0, 25);
    reversed.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "upcoming-roll-item" + (idx === 0 ? " is-next" : "");
      row.onclick = () => {
        selectedHistoryRoll = idx === 0 ? null : item;
        renderAllPredictorViews();
      };
      const diceHtml = (item.names || [])
        .slice(0, 14)
        .map((name) => {
          const c = Predictor.COLOR_BY_NAME[String(name).toUpperCase()] || Predictor.DICE_COLORS[0];
          return `<div class="upcoming-die-box" style="background-color:${c.hex};" title="${c.name}"><div class="upcoming-die-dot"></div></div>`;
        })
        .join("");
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <strong style="color:#FFEA3D;font-size:13px;">#${item.rollNumber}</strong>
          <span style="font-size:11px;color:rgba(255,255,255,0.5);">${item.timestamp}</span>
        </div>
        <div class="upcoming-mini-dice">${diceHtml}</div>
        <span style="font-size:11px;color:${idx === 0 ? "#FFEA3D" : "#4ADE80"};font-weight:800;">
          ${idx === 0 ? (item.isCustomLocked ? "🔒 API LOCKED" : "🔮 NEXT ON CLICK") : "✅ LANDED"}
        </span>
      `;
      listEl.appendChild(row);
    });
  }

  window.applyPredictorGameId = function (newIdInput) {
    const inputEl = document.getElementById("predictorIdInput");
    const raw = newIdInput !== undefined ? newIdInput : inputEl ? inputEl.value : "";
    const clean = Predictor.normalizeGameId(raw);
    if (!clean) {
      alert("Please enter a valid Offline Dice Game ID (e.g. #8F3A91 or 10-character session ID).");
      return;
    }
    activeId = clean;
    if (inputEl) inputEl.value = clean;
    selectedHistoryRoll = null;
    sessionHistory = [];
    loggedRollsCount = 1;
    firebaseNextRoll = null;

    const gameSess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (gameSess && Predictor.normalizeGameId(gameSess.gameId) === clean) {
      onScreenRollsCount = gameSess.rollCount || 0;
      if (autoDetectDiceCount && gameSess.diceCount) {
        currentDiceCount = gameSess.diceCount;
        const sel = document.getElementById("predictorDiceCountSelect");
        if (sel) sel.value = String(currentDiceCount);
      }
    }

    customDraftColors = [];
    connectSessionToFirebase(clean);
    renderAllPredictorViews();
  };

  /**
   * Generates a fresh predicted roll via /api/rig BEFORE the dice button is clicked!
   */
  window.preQueueNextRollForActiveId = async function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;

    const apiData = await callRigApi({
      action: "reroll",
      sessionId: clean,
      diceCount: currentDiceCount
    });

    if (apiData && apiData.ok) {
      applyApiDataToPredictorState(clean, apiData, false);
      customDraftColors = [...(apiData.activeNames || [])];
      renderAllPredictorViews();
      triggerInterceptBanner(
        `🔮 NEW NEXT DICE SYNCED VIA /api/rig (#${clean}): ${(apiData.activeNames || []).join(" • ").toUpperCase()}!`
      );
    }

    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (sess && Predictor.normalizeGameId(sess.gameId) === clean && window.queueNextRollInFirebase) {
      await window.queueNextRollInFirebase(
        Math.max(1, loggedRollsCount),
        currentDiceCount,
        apiData && apiData.activeNames ? apiData.activeNames : null,
        true
      );
    }
  };

  window.openPreSyncedGameTab = function () {
    const clean = Predictor.normalizeGameId(activeId);
    const url = clean ? `./game.html?id=${encodeURIComponent(clean)}` : `./game.html`;
    window.open(url, "_blank");
  };

  function getSilentHookCode() {
    return `(function(){const oldBar=document.getElementById("odHookPreviewBar");if(oldBar)oldBar.remove();if(window.__odApiRigActiveV120)return;window.__odApiRigActiveV120=true;const API_ENDPOINTS=["https://offlinedicerdd.vercel.app/api/rig","https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig"];const PALETTE=[{name:"Red",hex:"#FF0000"},{name:"Orange",hex:"#FFA500"},{name:"Yellow",hex:"#FFD700"},{name:"Green",hex:"#008000"},{name:"Blue",hex:"#0000FF"},{name:"Purple",hex:"#800080"}];window.__odRigState=null;window.__odRolling=false;window.__odLastSid="";function getSid(){const el=document.getElementById("gameIdDisplay");const txt=el?String(el.innerText||el.textContent||"").trim():"";if(txt&&txt.toUpperCase()!=="LOADING..."){const c=txt.toUpperCase().replace(/^#+/,"").replace(/[^A-Z0-9_-]/g,"");if(c)return c;}try{if(typeof y==="string"&&y.trim())return y.trim().toUpperCase().replace(/^#+/,"").replace(/[^A-Z0-9_-]/g,"");}catch(e){}return "";}function getDc(){const el=document.getElementById("diceCount");return el?Math.min(100,Math.max(1,parseInt(el.value,10)||4)):4;}function mapDice(names,dc){const pal=(typeof u!=="undefined"&&Array.isArray(u)&&u.length===6)?u:PALETTE;const src=Array.isArray(names)&&names.length>0?names:["Red","Orange","Yellow","Green"];const out=[];for(let i=0;i<dc;i++){const raw=String(src[i%src.length]||"").toUpperCase();const m=pal.find(c=>c.name.toUpperCase()===raw||c.hex.toUpperCase()===raw)||pal[0];out.push({name:m.name,hex:m.hex});}return out;}async function callApi(payload){const sid=payload.sessionId||getSid();if(!sid)return null;const body=Object.assign({sessionId:sid,diceCount:getDc(),action:"status"},payload);for(let i=0;i<API_ENDPOINTS.length;i++){try{const r=await fetch(API_ENDPOINTS[i]+"?sessionId="+encodeURIComponent(sid)+"&action="+encodeURIComponent(body.action)+"&_t="+Date.now(),{method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(r&&r.ok){const d=await r.json();if(d&&d.ok)return d;}}catch(e){}}return null;}async function syncStatus(force){if(window.__odRolling&&!force)return;const sid=getSid();if(!sid)return;const d=await callApi({action:"status",sessionId:sid,diceCount:getDc()});if(d&&d.ok)window.__odRigState=d;}async function hookedRoll(){if(window.__odRolling)return;try{if(typeof f!=="undefined"&&f)return;}catch(e){}window.__odRolling=true;try{if(typeof f!=="undefined")f=true;}catch(e){}const dc=getDc();const sid=getSid();const consumeP=callApi({action:"consume",sessionId:sid,diceCount:dc});const l=document.getElementById("rollOverlay"),i=document.getElementById("overlayTitle"),c=document.getElementById("overlayDiceContainer"),d=["You're Cooked...","Good Luck :)","Amazing!","Let's See...","Offline Dice On TOP!","Rolling..."];if(i)i.innerText=d[Math.floor(Math.random()*d.length)];if(c){c.innerHTML="";for(let k=0;k<dc;k++){const die=document.createElement("div");die.className="big-die";const dot=document.createElement("div");dot.className="big-die-dot";die.appendChild(dot);c.appendChild(die);}}setTimeout(()=>{c?.querySelectorAll(".big-die").forEach(el=>el.classList.add("initial-shake"));l?.classList.remove("hidden");try{if(typeof s!=="undefined"&&s){s.currentTime=0;s.play().catch(()=>{});}}catch(e){}setTimeout(async()=>{let res=null;try{res=await consumeP;}catch(e){}const names=(res&&Array.isArray(res.rollToLandNames)&&res.rollToLandNames.length>0)?res.rollToLandNames:((window.__odRigState&&Array.isArray(window.__odRigState.activeNames)&&window.__odRigState.activeNames.length>0)?window.__odRigState.activeNames:["Red","Red","Red","Red"]);const finalDice=mapDice(names,dc);if(res&&res.nextState){const ns=res.nextState;const locked=Boolean(ns.is_locked)&&Array.isArray(ns.locked_names)&&ns.locked_names.length>0;window.__odRigState={ok:true,sessionId:sid,mode:locked?"LOCKED":"PREDICTED",activeNames:locked?ns.locked_names:(ns.predicted_names||[]),state:ns};}l?.classList.add("hidden");try{if(typeof j==="function")j(finalDice,"");}catch(e){}window.__odRolling=false;try{if(typeof f!=="undefined")f=false;}catch(e){}setTimeout(()=>syncStatus(true),120);},1200);},700);}function attach(){const sid=getSid();if(!sid)return false;window.rollDice=hookedRoll;const btn=document.getElementById("rollBtn");if(btn&&!btn.__odApiHookedV120){btn.__odApiHookedV120=true;btn.addEventListener("click",ev=>{ev.stopImmediatePropagation();ev.preventDefault();hookedRoll();},true);}const dcEl=document.getElementById("diceCount");if(dcEl&&!dcEl.__odApiHookedV120){dcEl.__odApiHookedV120=true;dcEl.addEventListener("change",()=>callApi({action:"reroll",sessionId:getSid(),diceCount:getDc()}).then(d=>{if(d&&d.ok)window.__odRigState=d;}));}if(window.__odLastSid!==sid){window.__odLastSid=sid;syncStatus(true);}return true;}setInterval(()=>{attach();syncStatus(false);},1000);attach();})();`;
  }

  window.copyExternalSitePreClickHook = function () {
    const hookCode = getSilentHookCode();
    navigator.clipboard.writeText(hookCode).catch(() => {});
    const btn = document.getElementById("copyHookBtn");
    if (btn) {
      const old = btn.innerText;
      btn.innerText = "✅ v1.2.0 API SCRIPT COPIED!";
      setTimeout(() => {
        btn.innerText = old;
      }, 2200);
    }
    triggerInterceptBanner(
      `✅ v1.2.0 API HOOK COPIED! Connects offline-dice.com directly to https://offlinedicerdd.vercel.app/api/rig!`
    );
  };

  window.switchV110Option = function (opt) {
    v110ActiveOption = opt === 2 ? 2 : 1;
    const tab1 = document.getElementById("v110TabOpt1");
    const tab2 = document.getElementById("v110TabOpt2");
    const ctrl2 = document.getElementById("v110Option2Controller");
    if (tab1) tab1.classList.toggle("active-opt1", v110ActiveOption === 1);
    if (tab2) tab2.classList.toggle("active-opt2", v110ActiveOption === 2);
    if (ctrl2) {
      ctrl2.style.display = v110ActiveOption === 2 ? "block" : "none";
    }
    renderCustomLockerSlots(firebaseNextRoll);
  };

  window.setV110PersistMode = function (isRepeat) {
    v110PersistEveryRoll = Boolean(isRepeat);
    const btnSingle = document.getElementById("v110LockModeSingle");
    const btnRepeat = document.getElementById("v110LockModeRepeat");
    if (btnSingle) {
      btnSingle.style.background = !v110PersistEveryRoll ? "#FFEA3D" : "rgba(255,255,255,0.08)";
      btnSingle.style.color = !v110PersistEveryRoll ? "#000" : "#fff";
    }
    if (btnRepeat) {
      btnRepeat.style.background = v110PersistEveryRoll ? "#A855F7" : "rgba(255,255,255,0.08)";
      btnRepeat.style.color = v110PersistEveryRoll ? "#fff" : "#D8B4FE";
    }
    if (customDraftColors.length > 0) {
      v110LockedColors = [...customDraftColors];
      window.lockCustomNextRoll();
    }
  };

  window.instantForceSameColor = function (colorName) {
    const slotCount = Math.min(12, currentDiceCount);
    customDraftColors = Array(slotCount).fill(colorName);
    v110LockedColors = [...customDraftColors];
    renderCustomLockerSlots(firebaseNextRoll);
    window.lockCustomNextRoll();
  };

  window.setV110SingleDieColor = function (dieIdx, colorName) {
    const slotCount = Math.min(12, currentDiceCount);
    if (customDraftColors.length !== slotCount) {
      customDraftColors = Array(slotCount).fill("Red");
    }
    customDraftColors[dieIdx] = colorName;
    v110LockedColors = [...customDraftColors];
    renderCustomLockerSlots(firebaseNextRoll);
    window.lockCustomNextRoll();
  };

  window.syncWithActiveGameSession = function () {
    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    const savedId = localStorage.getItem("offlinedice_active_game_id");
    const idToUse = (sess && sess.gameId) || savedId || "";
    if (sess && sess.diceCount) {
      currentDiceCount = sess.diceCount;
      const sel = document.getElementById("predictorDiceCountSelect");
      if (sel) sel.value = String(currentDiceCount);
    }
    if (idToUse) {
      window.applyPredictorGameId(idToUse);
    }
  };

  window.syncGameToPredictorId = function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;
    if (window.setOfflineDiceSessionId) {
      window.setOfflineDiceSessionId(clean);
    }
    window.applyPredictorGameId(clean);
  };

  window.pasteGameIdFromClipboard = async function () {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        window.applyPredictorGameId(text.trim());
      }
    } catch (e) {
      const inputEl = document.getElementById("predictorIdInput");
      if (inputEl) inputEl.focus();
    }
  };

  window.copyActivePredictorId = function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;
    navigator.clipboard.writeText(clean).catch(() => {});
    const btn = document.getElementById("copyIdBtn");
    if (btn) {
      const old = btn.innerText;
      btn.innerText = "✅ COPIED!";
      setTimeout(() => {
        btn.innerText = old;
      }, 1400);
    }
  };

  window.handlePredictorDiceCountChange = function (val) {
    if (val === "auto") {
      autoDetectDiceCount = true;
    } else {
      autoDetectDiceCount = false;
      currentDiceCount = Math.min(100, Math.max(1, parseInt(val, 10) || 4));
      const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
      if (sess && Predictor.normalizeGameId(sess.gameId) === activeId) {
        const gameDc = document.getElementById("diceCount");
        if (gameDc) {
          gameDc.value = String(currentDiceCount);
        }
      }
      window.preQueueNextRollForActiveId();
    }
    customDraftColors = [];
    renderAllPredictorViews();
  };

  window.stepPredictionRoll = function (delta) {
    if (delta === 0) {
      selectedHistoryRoll = null;
      renderAllPredictorViews();
      return;
    }
    if (sessionHistory.length === 0) return;
    if (!selectedHistoryRoll) {
      selectedHistoryRoll = sessionHistory[Math.max(0, sessionHistory.length - 2)];
    } else {
      const idx = sessionHistory.findIndex((r) => r.rollNumber === selectedHistoryRoll.rollNumber);
      const nextIdx = Math.min(sessionHistory.length - 1, Math.max(0, idx + delta));
      selectedHistoryRoll = nextIdx === sessionHistory.length - 1 ? null : sessionHistory[nextIdx];
    }
    renderAllPredictorViews();
  };

  window.setAllLockerColor = function (colorName) {
    const slotCount = Math.min(12, currentDiceCount);
    customDraftColors = Array(slotCount).fill(colorName);
    v110LockedColors = [...customDraftColors];
    renderCustomLockerSlots(firebaseNextRoll);
    window.lockCustomNextRoll();
  };

  window.lockCustomNextRoll = async function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) {
      alert("Please enter the Game Session ID from offline-dice.com first!");
      return;
    }
    const nextNum = Math.max(1, loggedRollsCount || 1);
    const fullColors = [];
    for (let i = 0; i < currentDiceCount; i++) {
      fullColors.push(customDraftColors[i % customDraftColors.length] || "Red");
    }
    v110LockedColors = [...fullColors];

    const statusEl = document.getElementById("v110LiveLockStatus");
    if (statusEl) {
      statusEl.innerHTML = `⏳ SENDING LOCK TO <code>/api/rig</code> FOR <strong>#${clean}</strong>...`;
    }

    // 1. Optimistically update local UI immediately
    const rollObj = Predictor.generateRealCsprngRoll(clean, nextNum, currentDiceCount, fullColors);
    rollObj.isCustomLocked = true;
    firebaseNextRoll = rollObj;
    selectedHistoryRoll = null;
    renderAllPredictorViews();

    try {
      localStorage.setItem("od_locked_next_" + clean, JSON.stringify(rollObj));
    } catch (e) {}

    // 2. Send lock to https://offlinedicerdd.vercel.app/api/rig (backed by Supabase dice_rig_sessions)
    const apiData = await callRigApi({
      action: "lock",
      sessionId: clean,
      diceCount: currentDiceCount,
      lockedNames: fullColors,
      persistEveryRoll: v110PersistEveryRoll
    });

    if (apiData && apiData.ok) {
      applyApiDataToPredictorState(clean, apiData, false);
    } else if (statusEl) {
      statusEl.innerHTML = `✅ LOCKED FOR <strong>#${clean}</strong>: <span style="color:#FFEA3D;">${fullColors
        .join(" • ")
        .toUpperCase()}</span> — CLICK "ROLL AGAIN !" ON PC NOW!`;
    }

    // 3. Also update built-in game session if running on the same page
    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (sess && Predictor.normalizeGameId(sess.gameId) === clean && window.queueNextRollInFirebase) {
      await window.queueNextRollInFirebase(nextNum, currentDiceCount, fullColors, true);
    }

    triggerInterceptBanner(
      `🔒 API LOCKED FOR #${clean}: ${fullColors.join(" • ").toUpperCase()} — READY FOR OFFLINE-DICE.COM!`
    );
  };

  window.clearCustomNextRoll = function () {
    const clean = Predictor.normalizeGameId(activeId);
    v110LockedColors = [];
    v110PersistEveryRoll = false;
    const btnSingle = document.getElementById("v110LockModeSingle");
    const btnRepeat = document.getElementById("v110LockModeRepeat");
    if (btnSingle) {
      btnSingle.style.background = "#FFEA3D";
      btnSingle.style.color = "#000";
    }
    if (btnRepeat) {
      btnRepeat.style.background = "rgba(255,255,255,0.08)";
      btnRepeat.style.color = "#D8B4FE";
    }
    if (clean) {
      try {
        localStorage.removeItem("od_locked_next_" + clean);
      } catch (e) {}
    }
    if (firebaseNextRoll) firebaseNextRoll.isCustomLocked = false;
    window.preQueueNextRollForActiveId();
  };

  window.switchAppMode = function (mode) {
    currentMode = mode;
    const predSec = document.getElementById("predictorRootSection");
    const gameSec = document.getElementById("gameRootSection");
    const tabPred = document.getElementById("modeTabPredictor");
    const tabGame = document.getElementById("modeTabGame");
    const tabSplit = document.getElementById("modeTabSplit");

    document.body.classList.remove("split-mode-active");
    if (tabPred) tabPred.classList.remove("active", "active-gold");
    if (tabGame) tabGame.classList.remove("active", "active-gold");
    if (tabSplit) tabSplit.classList.remove("active", "active-gold");

    if (mode === "game") {
      if (predSec) predSec.style.display = "none";
      if (gameSec) gameSec.style.display = "flex";
      if (tabGame) tabGame.classList.add("active");
    } else if (mode === "split") {
      document.body.classList.add("split-mode-active");
      if (predSec) predSec.style.display = "block";
      if (gameSec) gameSec.style.display = "flex";
      if (tabSplit) tabSplit.classList.add("active-gold");
    } else {
      if (predSec) predSec.style.display = "block";
      if (gameSec) gameSec.style.display = "none";
      if (tabPred) tabPred.classList.add("active");
    }
  };

  function handleSyncMessage(msg) {
    if (!msg || !msg.gameId) return;
    const cleanMsgId = Predictor.normalizeGameId(msg.gameId);
    if (!activeId) {
      activeId = cleanMsgId;
      const inputEl = document.getElementById("predictorIdInput");
      if (inputEl) inputEl.value = activeId;
      connectSessionToFirebase(activeId);
    }
    if (cleanMsgId !== Predictor.normalizeGameId(activeId)) return;

    if (msg.type === "NEXT_ROLL_QUEUED" || msg.type === "NEXT_ROLL_UPDATED" || msg.type === "CUSTOM_ROLL_LOCKED") {
      if (msg.nextRoll) {
        firebaseNextRoll = msg.nextRoll;
        isCurrentlyRollingOnScreen = false;
        selectedHistoryRoll = null;
        renderAllPredictorViews();
      }
    } else if (msg.type === "DICE_COUNT_CHANGED" && msg.diceCount) {
      currentDiceCount = msg.diceCount;
      const sel = document.getElementById("predictorDiceCountSelect");
      if (sel) sel.value = String(currentDiceCount);
      if (msg.nextRoll) firebaseNextRoll = msg.nextRoll;
      customDraftColors = [];
      renderAllPredictorViews();
    } else if (msg.type === "ROLL_STARTED") {
      isCurrentlyRollingOnScreen = true;
      selectedHistoryRoll = null;
      triggerInterceptBanner(
        `🎲 DICE CLICKED — LANDING ON YOUR PRE-CLICK PREDICTION (${msg.roll.names.join(" • ").toUpperCase()})!`
      );
      if (soundAlertEnabled) Predictor.playAlertPing("intercept");
      renderAllPredictorViews();
    } else if (msg.type === "ROLL_COMPLETED") {
      isCurrentlyRollingOnScreen = false;
      onScreenRollsCount = msg.rollNumber || onScreenRollsCount + 1;
      selectedHistoryRoll = null;
      customDraftColors = [];
      renderAllPredictorViews();
    } else if (msg.type === "SESSION_INIT" || msg.type === "SESSION_CHANGED") {
      if (msg.diceCount) currentDiceCount = msg.diceCount;
      onScreenRollsCount = msg.rollCount || 0;
      if (msg.nextRoll) firebaseNextRoll = msg.nextRoll;
      selectedHistoryRoll = null;
      renderAllPredictorViews();
    }
  }

  function initPredictorUI() {
    const bmEl = document.getElementById("bookmarkletDragLink");
    if (bmEl) {
      bmEl.setAttribute("href", "javascript:" + getSilentHookCode());
    }
    const sel = document.getElementById("predictorDiceCountSelect");
    if (sel) {
      let optsHtml = `<option value="auto">⚡ AUTO-DETECT (FROM API)</option>`;
      for (let i = 1; i <= 100; i++) {
        optsHtml += `<option value="${i}" ${i === 4 ? 'selected="selected"' : ""}>${i} DICE</option>`;
      }
      sel.innerHTML = optsHtml;
    }

    window.addEventListener("offlinedice:sync", (e) => handleSyncMessage(e.detail));
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const ch = new BroadcastChannel("offlinedice_sync_channel");
        ch.onmessage = (ev) => handleSyncMessage(ev.data);
      } catch (e) {}
    }

    const inputEl = document.getElementById("predictorIdInput");
    if (inputEl) {
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          window.applyPredictorGameId(inputEl.value);
        }
      });
    }

    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get("mode");
    if (modeParam === "game" || modeParam === "split" || modeParam === "predictor") {
      window.switchAppMode(modeParam);
    } else {
      window.switchAppMode("predictor");
    }

    const urlId = params.get("id") || params.get("gameId");
    if (urlId) {
      window.applyPredictorGameId(urlId);
    } else {
      setTimeout(() => {
        window.syncWithActiveGameSession();
      }, 60);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPredictorUI);
  } else {
    initPredictorUI();
  }
})();
