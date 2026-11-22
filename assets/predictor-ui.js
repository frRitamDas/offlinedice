(function () {
  "use strict";

  const Predictor = window.OfflineDicePredictor;
  if (!Predictor) return;

  let currentMode = "predictor"; // 'predictor' | 'game' | 'split'
  let activeId = "";
  let currentDiceCount = 4;
  let autoDetectDiceCount = true;
  let loggedRollsCount = 0;
  let soundAlertEnabled = true;
  let sessionHistory = [];
  let firebaseNextRoll = null; // Exact roll from sessions/<ID>/next_roll
  let firebaseListeners = [];
  let customDraftColors = [];
  let selectedHistoryRoll = null; // If user clicks a specific past roll to inspect

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
  }

  function connectSessionToFirebase(cleanId) {
    detachFirebaseListeners();
    if (!cleanId) return;

    const db = getDb();
    const connBadge = document.getElementById("predConnectionBadge");
    if (!db) {
      if (connBadge) {
        connBadge.innerHTML = `<span class="predictor-status-dot"></span> CONNECTING TO FIREBASE...`;
      }
      return;
    }

    if (connBadge) {
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> FIREBASE LIVE CONNECTED (#${cleanId})`;
    }

    // 1. Listen to sessions/<cleanId>/next_roll (Pre-queued exact next roll before button click)
    const nextRollRef = db.ref("sessions/" + cleanId + "/next_roll");
    const onNextRoll = (snap) => {
      if (!snap.exists()) {
        firebaseNextRoll = null;
        renderAllPredictorViews();
        return;
      }
      const val = snap.val() || {};
      let names = Array.isArray(val.names) ? val.names : [];
      if (names.length === 0 && Array.isArray(val.colors)) {
        names = val.colors.map((hex) => {
          const c = Predictor.COLOR_BY_HEX[String(hex).toUpperCase()];
          return c ? c.name : "Red";
        });
      }
      if (names.length > 0) {
        const rollObj = Predictor.buildRollObject(
          cleanId,
          val.rollNumber || loggedRollsCount + 1,
          names,
          val.hash || "",
          val.time || Date.now(),
          Boolean(val.isCustomLocked)
        );
        rollObj.status = val.status || "queued";
        firebaseNextRoll = rollObj;
        selectedHistoryRoll = null;

        if (autoDetectDiceCount && names.length !== currentDiceCount) {
          currentDiceCount = names.length;
          const sel = document.getElementById("predictorDiceCountSelect");
          if (sel) sel.value = String(currentDiceCount);
        }

        if (val.status === "rolling") {
          triggerInterceptBanner(
            `⚡ ROLL #${rollObj.rollNumber} CLICKED — LANDING ON EXACT FIREBASE DICE: ${rollObj.names.join(", ")} (1.9s BEFORE SCREEN)!`
          );
          if (soundAlertEnabled) Predictor.playAlertPing("intercept");
        }
      } else {
        firebaseNextRoll = null;
      }
      renderAllPredictorViews();
    };
    nextRollRef.on("value", onNextRoll);
    firebaseListeners.push({ ref: nextRollRef, event: "value", cb: onNextRoll });

    // 2. Listen to sessions/<cleanId>/meta
    const metaRef = db.ref("sessions/" + cleanId + "/meta");
    const onMeta = (snap) => {
      if (!snap.exists()) return;
      const meta = snap.val() || {};
      if (autoDetectDiceCount && meta.diceCount && Number.isFinite(Number(meta.diceCount))) {
        const dc = Math.min(100, Math.max(1, parseInt(meta.diceCount, 10)));
        if (dc !== currentDiceCount) {
          currentDiceCount = dc;
          const sel = document.getElementById("predictorDiceCountSelect");
          if (sel) sel.value = String(dc);
          renderAllPredictorViews();
        }
      }
    };
    metaRef.on("value", onMeta);
    firebaseListeners.push({ ref: metaRef, event: "value", cb: onMeta });

    // 3. Listen to sessions/<cleanId>/rolls in real time (catches offline-dice.com rollDiceSecure 1.9s before animation ends!)
    const rollsRef = db.ref("sessions/" + cleanId + "/rolls");
    let initialLoadDone = false;
    let prevCount = 0;

    const onRolls = (snap) => {
      const rolls = [];
      if (snap.exists()) {
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
          const built = Predictor.buildRollObject(
            cleanId,
            data.rollNumber || idx,
            names,
            data.hash || "",
            data.time || Date.now(),
            false
          );
          built.key = childSnap.key;
          built.timestamp = timeStr;
          rolls.push(built);
          idx++;
        });
      }

      sessionHistory = rolls;
      loggedRollsCount = rolls.length;

      if (autoDetectDiceCount && rolls.length > 0) {
        const lastRoll = rolls[rolls.length - 1];
        if (lastRoll.names && lastRoll.names.length > 0 && lastRoll.names.length !== currentDiceCount) {
          currentDiceCount = lastRoll.names.length;
          const sel = document.getElementById("predictorDiceCountSelect");
          if (sel) sel.value = String(currentDiceCount);
        }
      }

      if (initialLoadDone && rolls.length > prevCount) {
        const latest = rolls[rolls.length - 1];
        selectedHistoryRoll = null;
        triggerInterceptBanner(
          `⚡ LIVE FIREBASE ROLL #${rolls.length} INTERCEPTED (1.9s BEFORE DICE LAND): ${latest.names.join(" • ").toUpperCase()}!`
        );
        if (soundAlertEnabled) {
          Predictor.playAlertPing("intercept");
        }
      }

      prevCount = rolls.length;
      initialLoadDone = true;
      renderAllPredictorViews();
    };

    rollsRef.on("value", onRolls);
    firebaseListeners.push({ ref: rollsRef, event: "value", cb: onRolls });
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
    }, 4500);
  }

  /**
   * Determines which 100% REAL Firebase roll to display in the main showcase (NEVER guesses!).
   */
  function getActiveFirebaseRollToDisplay() {
    if (selectedHistoryRoll) {
      return { roll: selectedHistoryRoll, mode: "HISTORY_INSPECT" };
    }
    // If there is a pre-queued next_roll in Firebase for the upcoming roll (or currently rolling)
    if (
      firebaseNextRoll &&
      firebaseNextRoll.dice &&
      firebaseNextRoll.dice.length > 0 &&
      (firebaseNextRoll.rollNumber > loggedRollsCount || firebaseNextRoll.status === "rolling")
    ) {
      return {
        roll: firebaseNextRoll,
        mode: firebaseNextRoll.status === "rolling" ? "LIVE_ROLLING_NOW" : "QUEUED_BEFORE_ROLL"
      };
    }
    // Otherwise, if rolls exist in sessions/<ID>/rolls (e.g., from offline-dice.com rollDiceSecure), show the latest exact Firebase roll
    if (sessionHistory.length > 0) {
      return {
        roll: sessionHistory[sessionHistory.length - 1],
        mode: "LATEST_FIREBASE_ROLL"
      };
    }
    return { roll: null, mode: "WAITING_FOR_FIREBASE" };
  }

  function renderAllPredictorViews() {
    const cleanId = Predictor.normalizeGameId(activeId) || "READY";
    const displayState = getActiveFirebaseRollToDisplay();
    const activeRoll = displayState.roll;

    // Update Telemetry Strip
    const elId = document.getElementById("telActiveId");
    const elLogged = document.getElementById("telRollsLogged");
    const elTarget = document.getElementById("telTargetRoll");
    const elDiceCount = document.getElementById("telDiceCount");

    if (elId) elId.textContent = "#" + cleanId;
    if (elLogged) elLogged.textContent = `${loggedRollsCount} Logged in DB`;
    if (elTarget) {
      if (displayState.mode === "QUEUED_BEFORE_ROLL") {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (QUEUED NEXT)`;
      } else if (displayState.mode === "LIVE_ROLLING_NOW") {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (ROLLING NOW!)`;
      } else if (displayState.mode === "LATEST_FIREBASE_ROLL") {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (LIVE DB)`;
      } else {
        elTarget.textContent = `WAITING FOR ROLL #1`;
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
      // Waiting state — NO FAKE GUESSING!
      if (stageBadge) {
        stageBadge.innerHTML = `📡 LISTENING TO FIREBASE SESSION #${cleanId} — WAITING FOR ROLL`;
      }
      if (hashBadge) {
        hashBadge.textContent = `ZERO GUESSING MODE • 100% REAL FIREBASE STREAM`;
      }
      if (diceShowcase) {
        diceShowcase.innerHTML = `
          <div style="text-align:center; padding: 18px 16px; max-width: 540px;">
            <div style="font-size: 16px; font-weight: 800; color: #00D2FF; margin-bottom: 6px;">
              📡 Connected Live to Firebase Session <span style="color:#FFEA3D;">#${cleanId}</span>
            </div>
            <div style="font-size: 13px; color: rgba(255,255,255,0.78); line-height: 1.5; margin-bottom: 12px;">
              Waiting for the next roll in Firebase. The exact millisecond <strong>"ROLL AGAIN !"</strong> is clicked on Offline Dice, the server writes the roll to Firebase <strong>1.9 seconds before the dice land</strong> and the exact colors appear right here!
            </div>
            <button class="predictor-mini-btn" style="border-color:#FFEA3D; color:#FFEA3D; padding:8px 14px; font-size:13px;" onclick="preQueueNextRollForActiveId()">
              🔮 Pre-Queue Exact Next Roll (#${loggedRollsCount + 1}) in Firebase Now
            </button>
          </div>
        `;
      }
      if (seqBar) {
        seqBar.innerHTML = `<span style="color:rgba(255,255,255,0.65);">No rolls in Firebase for <strong>#${cleanId}</strong> yet. Click "Pre-Queue" above or click "Roll Again !" on the game.</span>`;
      }
      if (breakdownGrid) {
        breakdownGrid.innerHTML = "";
      }
    } else {
      // We have a 100% REAL Firebase roll (either pre-queued in sessions/<ID>/next_roll or live from sessions/<ID>/rolls)!
      if (stageBadge) {
        if (displayState.mode === "QUEUED_BEFORE_ROLL") {
          stageBadge.innerHTML = `🔮 EXACT NEXT DICE QUEUED IN FIREBASE — ROLL #${activeRoll.rollNumber} (BEFORE DICE) ${
            activeRoll.isCustomLocked ? '<span style="color:#FFEA3D;margin-left:6px;">[🔒 LOCKED]</span>' : ""
          }`;
        } else if (displayState.mode === "LIVE_ROLLING_NOW") {
          stageBadge.innerHTML = `⚡ ROLL #${activeRoll.rollNumber} ROLLING NOW — EXACT DICE LANDING ON SCREEN!`;
        } else if (displayState.mode === "HISTORY_INSPECT") {
          stageBadge.innerHTML = `🔍 INSPECTING FIREBASE ROLL #${activeRoll.rollNumber} (FROM DATABASE)`;
        } else {
          stageBadge.innerHTML = `⚡ EXACT FIREBASE ROLL #${activeRoll.rollNumber} — LIVE FROM DATABASE`;
        }
      }
      if (hashBadge) {
        const srcText =
          displayState.mode === "QUEUED_BEFORE_ROLL"
            ? "SOURCE: FIREBASE sessions/" + cleanId + "/next_roll (READY BEFORE ROLL)"
            : "SOURCE: FIREBASE sessions/" + cleanId + "/rolls (100% VERIFIED)";
        hashBadge.textContent = `${srcText} • HASH: ${activeRoll.hash || "LIVE"}`;
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
        seqBar.innerHTML = `
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span style="color:#FFEA3D;font-weight:800;margin-right:4px;">EXACT COLORS:</span>
            ${seqHtml}${moreTxt}
          </div>
          <div style="color:#00D2FF;font-weight:800;font-size:12.5px;">
            DOMINANT: <span style="color:#FFF;">${activeRoll.dominantColor.toUpperCase()} (${activeRoll.dominantCount}/${activeRoll.diceCount})</span>
          </div>
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

    // Render Firebase Pre-Queue & Recent Verified Rolls in the lower queue section
    renderFirebaseQueueAndRecentSection(cleanId);

    // Render Custom Locker Editor Slots
    renderCustomLockerSlots(activeRoll);

    // Render Live Session History Feed
    renderSessionHistoryFeed(cleanId);
  }

  function renderFirebaseQueueAndRecentSection(cleanId) {
    const queueList = document.getElementById("predUpcomingQueueList");
    if (!queueList) return;
    queueList.innerHTML = "";

    // Show Pre-Queued Next Roll from Firebase if available
    if (firebaseNextRoll && firebaseNextRoll.dice && firebaseNextRoll.dice.length > 0) {
      const nextItem = document.createElement("div");
      nextItem.className = "upcoming-roll-item is-next";
      nextItem.onclick = () => {
        selectedHistoryRoll = null;
        renderAllPredictorViews();
      };
      const diceBoxes = firebaseNextRoll.dice
        .slice(0, 14)
        .map(
          (d) => `
          <div class="upcoming-die-box" style="background-color: ${d.hex};" title="Die #${d.dieNumber}: ${d.name}">
            <div class="upcoming-die-dot"></div>
          </div>`
        )
        .join("");
      nextItem.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <strong style="font-size:13.5px;color:#FFEA3D;">NEXT ROLL #${firebaseNextRoll.rollNumber}</strong>
          <span style="background:#22C55E;color:#000;font-size:10px;font-weight:900;padding:2px 6px;border-radius:4px;text-transform:uppercase;">QUEUED IN FIREBASE (BEFORE ROLL)</span>
          ${firebaseNextRoll.isCustomLocked ? '<span style="font-size:11px;color:#C084FC;font-weight:800;">🔒 Custom Locked</span>' : ""}
        </div>
        <div class="upcoming-mini-dice">${diceBoxes}</div>
        <div style="font-size:12px;color:#FFFFFF;font-weight:800;">
          ${firebaseNextRoll.names.slice(0, 6).join(" • ")}
        </div>
      `;
      queueList.appendChild(nextItem);
    }

    // Show the last 4 real rolls from Firebase sessions/<ID>/rolls
    const recentRolls = [...sessionHistory].reverse().slice(0, 4);
    recentRolls.forEach((r, idx) => {
      const item = document.createElement("div");
      item.className = "upcoming-roll-item";
      item.onclick = () => {
        selectedHistoryRoll = r;
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
      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <strong style="font-size:13.5px;color:#00D2FF;">ROLL #${r.rollNumber}</strong>
          <span style="font-size:11px;color:rgba(255,255,255,0.55);">${r.timestamp || ""}</span>
          ${idx === 0 ? '<span style="background:rgba(0,210,255,0.2);color:#00D2FF;font-size:10px;font-weight:800;padding:2px 6px;border-radius:4px;">LATEST DB ROLL</span>' : ""}
        </div>
        <div class="upcoming-mini-dice">${diceBoxes}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.85);font-weight:700;">
          ${r.names.slice(0, 6).join(" • ")}
        </div>
      `;
      queueList.appendChild(item);
    });

    if (queueList.children.length === 0) {
      queueList.innerHTML = `
        <div style="padding:12px;text-align:center;color:rgba(255,255,255,0.6);font-size:12.5px;">
          Waiting for Firebase activity on session <strong>#${cleanId}</strong>...
        </div>
      `;
    }
  }

  function renderCustomLockerSlots(activeRoll) {
    const container = document.getElementById("lockerDiceSlots");
    if (!container) return;
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
    if (rollNumSpan) rollNumSpan.textContent = `Next Roll #${loggedRollsCount + 1}`;

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

  function renderSessionHistoryFeed(cleanId) {
    const listEl = document.getElementById("predSessionHistoryList");
    const countBadge = document.getElementById("predHistoryCountBadge");
    if (countBadge) countBadge.textContent = `${sessionHistory.length} Rolls`;
    if (!listEl) return;

    if (sessionHistory.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 18px; text-align: center; color: rgba(255,255,255,0.6); font-size: 13px; background: rgba(0,0,0,0.35); border-radius: 10px;">
          No completed rolls in Firebase for <strong>#${cleanId}</strong> yet.
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
        selectedHistoryRoll = item;
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
        <span style="font-size:11px;color:#4ADE80;font-weight:800;">✅ FIREBASE DB</span>
      `;
      listEl.appendChild(row);
    });
  }

  // Public UI Actions
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
    loggedRollsCount = 0;
    firebaseNextRoll = null;

    // Check if this ID matches our active local Game session
    const gameSess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (gameSess && Predictor.normalizeGameId(gameSess.gameId) === clean) {
      loggedRollsCount = gameSess.rollCount || 0;
      if (gameSess.queuedNextRoll) {
        firebaseNextRoll = gameSess.queuedNextRoll;
      }
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

  window.preQueueNextRollForActiveId = function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;
    const nextNum = loggedRollsCount + 1;
    const rollObj = Predictor.generateRealCsprngRoll(clean, nextNum, currentDiceCount, null);
    firebaseNextRoll = rollObj;
    selectedHistoryRoll = null;
    const db = getDb();
    if (db) {
      db.ref("sessions/" + clean + "/next_roll")
        .set({
          colors: rollObj.colors,
          names: rollObj.names,
          rollNumber: nextNum,
          diceCount: currentDiceCount,
          hash: rollObj.hash,
          isCustomLocked: false,
          status: "queued",
          time: Date.now()
        })
        .catch(() => {});
    }
    renderAllPredictorViews();
    triggerInterceptBanner(`🔮 NEXT ROLL #${nextNum} QUEUED IN FIREBASE FOR #${clean}: ${rollObj.names.join(", ")}!`);
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
        if (window.queueNextRollInFirebase) {
          window.queueNextRollInFirebase(loggedRollsCount + 1, currentDiceCount);
        }
      } else if (firebaseNextRoll) {
        window.preQueueNextRollForActiveId();
      }
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
      selectedHistoryRoll = sessionHistory[sessionHistory.length - 1];
    } else {
      const idx = sessionHistory.findIndex((r) => r.rollNumber === selectedHistoryRoll.rollNumber);
      const nextIdx = Math.min(sessionHistory.length - 1, Math.max(0, idx + delta));
      selectedHistoryRoll = sessionHistory[nextIdx];
    }
    renderAllPredictorViews();
  };

  window.setAllLockerColor = function (colorName) {
    const slotCount = Math.min(12, currentDiceCount);
    customDraftColors = Array(slotCount).fill(colorName);
    renderCustomLockerSlots(firebaseNextRoll);
  };

  window.lockCustomNextRoll = function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;
    const nextNum = loggedRollsCount + 1;
    const fullColors = [];
    for (let i = 0; i < currentDiceCount; i++) {
      fullColors.push(customDraftColors[i % customDraftColors.length] || "Red");
    }
    const rollObj = Predictor.generateRealCsprngRoll(clean, nextNum, currentDiceCount, fullColors);
    firebaseNextRoll = rollObj;
    selectedHistoryRoll = null;

    // Also update local Game if same ID
    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (sess && Predictor.normalizeGameId(sess.gameId) === clean && window.queueNextRollInFirebase) {
      window.queueNextRollInFirebase(nextNum, currentDiceCount, fullColors);
    } else {
      const db = getDb();
      if (db) {
        db.ref(`sessions/${clean}/next_roll`)
          .set({
            colors: rollObj.colors,
            names: rollObj.names,
            rollNumber: nextNum,
            diceCount: currentDiceCount,
            hash: rollObj.hash,
            isCustomLocked: true,
            status: "queued",
            time: Date.now()
          })
          .catch(() => {});
      }
    }

    renderAllPredictorViews();
    triggerInterceptBanner(`🔒 LOCKED EXACT NEXT DICE IN FIREBASE FOR #${clean}: ${rollObj.names.join(", ")}!`);
  };

  window.clearCustomNextRoll = function () {
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

    if (msg.type === "NEXT_ROLL_QUEUED" || msg.type === "NEXT_ROLL_UPDATED") {
      if (msg.nextRoll) {
        firebaseNextRoll = msg.nextRoll;
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
      if (msg.roll) {
        firebaseNextRoll = { ...msg.roll, status: "rolling" };
      }
      selectedHistoryRoll = null;
      triggerInterceptBanner(
        `⚡ ROLL #${msg.rollNumber} CLICKED — LANDING ON EXACT FIREBASE DICE (${msg.roll.names.join(", ")}) IN 1.9s!`
      );
      if (soundAlertEnabled) Predictor.playAlertPing("intercept");
      renderAllPredictorViews();
    } else if (msg.type === "ROLL_COMPLETED") {
      loggedRollsCount = msg.rollNumber;
      selectedHistoryRoll = null;
      customDraftColors = [];
      renderAllPredictorViews();
    } else if (msg.type === "SESSION_INIT" || msg.type === "SESSION_CHANGED") {
      if (msg.diceCount) currentDiceCount = msg.diceCount;
      loggedRollsCount = msg.rollCount || 0;
      if (msg.nextRoll) firebaseNextRoll = msg.nextRoll;
      selectedHistoryRoll = null;
      renderAllPredictorViews();
    }
  }

  function initPredictorUI() {
    const sel = document.getElementById("predictorDiceCountSelect");
    if (sel) {
      let optsHtml = `<option value="auto">⚡ AUTO-DETECT (FROM FIREBASE)</option>`;
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
