(function () {
  "use strict";

  const Predictor = window.OfflineDicePredictor;
  if (!Predictor) return;

  let currentMode = "predictor"; // 'predictor' | 'game' | 'split'
  let activeId = "";
  let currentDiceCount = 4;
  let autoDetectDiceCount = true;
  let loggedRollsCount = 0;
  let targetRollNumber = 1;
  let autoAdvanceRoll = true;
  let soundAlertEnabled = true;
  let sessionHistory = [];
  let firebaseListeners = [];
  let customDraftColors = [];

  function getDb() {
    if (window.firebaseDbInstance) return window.firebaseDbInstance;
    try {
      return window.firebase ? window.firebase.database() : null;
    } catch (e) {
      return null;
    }
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
        connBadge.innerHTML = `<span class="predictor-status-dot"></span> OFFLINE ID ENGINE ACTIVE`;
      }
      return;
    }

    if (connBadge) {
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> FIREBASE LIVE + ID ENGINE SYNCED`;
    }

    // Listen to meta (diceCount, rollCount)
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

    // Listen to rolls in real time
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
          rolls.push({
            key: childSnap.key,
            rollNumber: data.rollNumber || idx,
            timestamp: timeStr,
            names: names,
            hash: data.hash || ""
          });
          idx++;
        });
      }

      sessionHistory = rolls;
      loggedRollsCount = rolls.length;

      // Auto-detect dice count from latest roll if auto-detect is on
      if (autoDetectDiceCount && rolls.length > 0) {
        const lastRoll = rolls[rolls.length - 1];
        if (lastRoll.names && lastRoll.names.length > 0 && lastRoll.names.length !== currentDiceCount) {
          currentDiceCount = lastRoll.names.length;
          const sel = document.getElementById("predictorDiceCountSelect");
          if (sel) sel.value = String(currentDiceCount);
        }
      }

      if (initialLoadDone && rolls.length > prevCount) {
        // A new roll just hit Firebase (either from external offline-dice.com or live game)!
        const latest = rolls[rolls.length - 1];
        triggerInterceptBanner(
          `⚡ LIVE ROLL #${rolls.length} DETECTED IN FIREBASE (${latest.names.join(", ")}) — AUTO-ADVANCING TO ROLL #${rolls.length + 1}!`
        );
        if (soundAlertEnabled) {
          Predictor.playAlertPing("intercept");
        }
      }

      prevCount = rolls.length;
      initialLoadDone = true;

      if (autoAdvanceRoll) {
        targetRollNumber = loggedRollsCount + 1;
      }

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
    }, 3200);
  }

  function renderAllPredictorViews() {
    const cleanId = Predictor.normalizeGameId(activeId) || "READY";

    // Update Telemetry Strip
    const elId = document.getElementById("telActiveId");
    const elLogged = document.getElementById("telRollsLogged");
    const elTarget = document.getElementById("telTargetRoll");
    const elDiceCount = document.getElementById("telDiceCount");

    if (elId) elId.textContent = "#" + cleanId;
    if (elLogged) elLogged.textContent = `${loggedRollsCount} Rolled`;
    if (elTarget) {
      const isNextLive = targetRollNumber === loggedRollsCount + 1;
      elTarget.textContent = `ROLL #${targetRollNumber}${isNextLive ? " (NEXT)" : ""}`;
    }
    if (elDiceCount) elDiceCount.textContent = `${currentDiceCount} DICE`;

    // Compute exact prediction for (cleanId, targetRollNumber, currentDiceCount)
    const pred = Predictor.predictRollById(cleanId, targetRollNumber, currentDiceCount);

    // Update Stage Header Badge
    const stageBadge = document.getElementById("predStageRollBadge");
    if (stageBadge) {
      const tag = targetRollNumber === loggedRollsCount + 1 ? "NEXT DICE BEFORE ROLL" : "FORECAST PREVIEW";
      stageBadge.innerHTML = `🎯 ROLL #${pred.rollNumber} — ${tag} ${
        pred.isCustomLocked ? '<span style="color:#FFEA3D; margin-left:6px;">[🔒 CUSTOM LOCKED]</span>' : ""
      }`;
    }

    const hashBadge = document.getElementById("predStageHash");
    if (hashBadge) {
      hashBadge.textContent = `ID SEED HASH: ${pred.hash}`;
    }

    // Render Main Predicted 3D Dice
    const diceShowcase = document.getElementById("predDiceShowcase");
    if (diceShowcase) {
      diceShowcase.innerHTML = "";
      const frag = document.createDocumentFragment();
      pred.dice.forEach((die) => {
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

    // Render Exact Sequence Summary
    const seqBar = document.getElementById("predSequenceText");
    if (seqBar) {
      const seqHtml = pred.dice
        .slice(0, 16)
        .map(
          (d) =>
            `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.55);padding:3px 8px;border-radius:6px;border:1px solid ${d.hex};"><strong style="color:rgba(255,255,255,0.65);">#${d.dieNumber}:</strong> <strong style="color:${d.hex};">${d.name.toUpperCase()}</strong></span>`
        )
        .join(" ");
      const moreTxt = pred.dice.length > 16 ? ` <span style="color:#aaa;">+${pred.dice.length - 16} more</span>` : "";
      seqBar.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          <span style="color:#FFEA3D;font-weight:800;margin-right:4px;">EXACT ORDER:</span>
          ${seqHtml}${moreTxt}
        </div>
        <div style="color:#00D2FF;font-weight:800;font-size:12.5px;">
          TOP COLOR: <span style="color:#FFF;">${pred.dominantColor.toUpperCase()} (${pred.dominantCount}/${pred.diceCount})</span>
        </div>
      `;
    }

    // Render 6-Color Breakdown Chips
    const breakdownGrid = document.getElementById("predColorBreakdown");
    if (breakdownGrid) {
      breakdownGrid.innerHTML = "";
      Predictor.DICE_COLORS.forEach((c) => {
        const count = pred.counts[c.name] || 0;
        const pct = Math.round((count / pred.diceCount) * 100);
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

    // Render Upcoming 5-Roll Queue
    const queueList = document.getElementById("predUpcomingQueueList");
    if (queueList) {
      queueList.innerHTML = "";
      const startRoll = loggedRollsCount + 1;
      const queue = Predictor.predictUpcomingQueue(cleanId, startRoll, currentDiceCount, 5);
      queue.forEach((qRoll, idx) => {
        const item = document.createElement("div");
        const isCurrentTarget = qRoll.rollNumber === targetRollNumber;
        item.className = "upcoming-roll-item" + (idx === 0 ? " is-next" : "");
        if (isCurrentTarget) {
          item.style.outline = "2px solid #00D2FF";
        }
        item.onclick = () => {
          autoAdvanceRoll = qRoll.rollNumber === loggedRollsCount + 1;
          targetRollNumber = qRoll.rollNumber;
          renderAllPredictorViews();
        };

        const diceBoxes = qRoll.dice
          .slice(0, 14)
          .map(
            (d) => `
            <div class="upcoming-die-box" style="background-color: ${d.hex};" title="Die #${d.dieNumber}: ${d.name}">
              <div class="upcoming-die-dot"></div>
            </div>`
          )
          .join("");
        const extra = qRoll.dice.length > 14 ? `<span style="font-size:11px;color:#aaa;">+${qRoll.dice.length - 14}</span>` : "";

        item.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:13.5px;color:${idx === 0 ? "#FFEA3D" : "#00D2FF"};">ROLL #${qRoll.rollNumber}</strong>
            ${
              idx === 0
                ? '<span style="background:#FFEA3D;color:#000;font-size:10px;font-weight:900;padding:2px 6px;border-radius:4px;text-transform:uppercase;">COMING NEXT</span>'
                : `<span style="color:rgba(255,255,255,0.55);font-size:11.5px;">+${idx} Ahead</span>`
            }
            ${qRoll.isCustomLocked ? '<span style="font-size:11px;color:#C084FC;font-weight:800;">🔒 Locked</span>' : ""}
          </div>
          <div class="upcoming-mini-dice">
            ${diceBoxes}${extra}
          </div>
          <div style="font-size:12px;color:rgba(255,255,255,0.8);font-weight:700;">
            ${qRoll.names.slice(0, 6).join(" • ")}${qRoll.names.length > 6 ? "..." : ""}
          </div>
        `;
        queueList.appendChild(item);
      });
    }

    // Render Custom Locker Editor Slots
    renderCustomLockerSlots(pred);

    // Render Live Session History Feed
    renderSessionHistoryFeed(cleanId);
  }

  function renderCustomLockerSlots(currentPred) {
    const container = document.getElementById("lockerDiceSlots");
    if (!container) return;
    const slotCount = Math.min(12, currentDiceCount);
    if (customDraftColors.length !== slotCount) {
      customDraftColors = currentPred.dice.slice(0, slotCount).map((d) => d.name);
    }

    const rollNumSpan = document.getElementById("lockerTargetRollLabel");
    if (rollNumSpan) rollNumSpan.textContent = `Roll #${targetRollNumber}`;

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
        renderCustomLockerSlots(currentPred);
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
          No rolls logged yet for <strong>#${cleanId}</strong>.<br>
          <span style="color:#00D2FF;font-weight:700;">Roll #1 is already predicted and ready above before you roll!</span>
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    const reversed = [...sessionHistory].reverse().slice(0, 25);
    reversed.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "upcoming-roll-item" + (idx === 0 ? " is-next" : "");
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
        <span style="font-size:11px;color:#4ADE80;font-weight:800;">✅ MATCHED</span>
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

    // If the integrated game has a different ID and user wants them synced, check if this matches active game
    const gameSess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (gameSess && Predictor.normalizeGameId(gameSess.gameId) === clean) {
      loggedRollsCount = gameSess.rollCount || 0;
      if (autoDetectDiceCount && gameSess.diceCount) {
        currentDiceCount = gameSess.diceCount;
        const sel = document.getElementById("predictorDiceCountSelect");
        if (sel) sel.value = String(currentDiceCount);
      }
    } else {
      loggedRollsCount = 0;
      sessionHistory = [];
    }

    targetRollNumber = loggedRollsCount + 1;
    autoAdvanceRoll = true;
    customDraftColors = [];
    connectSessionToFirebase(clean);
    renderAllPredictorViews();
    if (soundAlertEnabled) Predictor.playAlertPing("predict");
  };

  window.syncWithActiveGameSession = function () {
    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    const savedId = localStorage.getItem("offlinedice_active_game_id");
    const idToUse = (sess && sess.gameId) || savedId || "8F3A91";
    if (sess && sess.diceCount) {
      currentDiceCount = sess.diceCount;
      const sel = document.getElementById("predictorDiceCountSelect");
      if (sel) sel.value = String(currentDiceCount);
    }
    window.applyPredictorGameId(idToUse);
  };

  window. syncGameToPredictorId = function () {
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
      const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
      if (sess && Predictor.normalizeGameId(sess.gameId) === activeId && sess.diceCount) {
        currentDiceCount = sess.diceCount;
      }
    } else {
      autoDetectDiceCount = false;
      currentDiceCount = Math.min(100, Math.max(1, parseInt(val, 10) || 4));
      // Also update integrated game diceCount if sharing the same ID
      const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
      if (sess && Predictor.normalizeGameId(sess.gameId) === activeId) {
        const gameDc = document.getElementById("diceCount");
        if (gameDc) {
          gameDc.value = String(currentDiceCount);
        }
      }
    }
    customDraftColors = [];
    renderAllPredictorViews();
  };

  window.stepPredictionRoll = function (delta) {
    if (delta === 0) {
      autoAdvanceRoll = true;
      targetRollNumber = loggedRollsCount + 1;
    } else {
      autoAdvanceRoll = false;
      targetRollNumber = Math.max(1, targetRollNumber + delta);
    }
    customDraftColors = [];
    renderAllPredictorViews();
  };

  window.setAllLockerColor = function (colorName) {
    const slotCount = Math.min(12, currentDiceCount);
    customDraftColors = Array(slotCount).fill(colorName);
    const pred = Predictor.predictRollById(activeId, targetRollNumber, currentDiceCount);
    renderCustomLockerSlots(pred);
  };

  window.lockCustomNextRoll = function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;
    const fullColors = [];
    for (let i = 0; i < currentDiceCount; i++) {
      fullColors.push(customDraftColors[i % customDraftColors.length] || "Red");
    }
    Predictor.saveForcedOverride(clean, targetRollNumber, fullColors);
    try {
      const db = getDb();
      if (db) {
        db.ref(`sessions/${clean}/forced_rolls/${targetRollNumber}`).set(fullColors).catch(() => {});
      }
    } catch (e) {}
    renderAllPredictorViews();
    triggerInterceptBanner(`🔒 LOCKED CUSTOM DICE FOR ID #${clean} (ROLL #${targetRollNumber})!`);
  };

  window.clearCustomNextRoll = function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;
    Predictor.saveForcedOverride(clean, targetRollNumber, null);
    try {
      const db = getDb();
      if (db) {
        db.ref(`sessions/${clean}/forced_rolls/${targetRollNumber}`).remove().catch(() => {});
      }
    } catch (e) {}
    customDraftColors = [];
    renderAllPredictorViews();
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

    if (msg.type === "DICE_COUNT_CHANGED" && msg.diceCount) {
      currentDiceCount = msg.diceCount;
      const sel = document.getElementById("predictorDiceCountSelect");
      if (sel) sel.value = String(currentDiceCount);
      customDraftColors = [];
      renderAllPredictorViews();
    } else if (msg.type === "ROLL_STARTED") {
      triggerInterceptBanner(
        `⚡ ROLL #${msg.rollNumber} TRIGGERED ON GAME — LANDING ON PREDICTED DICE (${msg.roll.names.join(", ")}) IN 1.9s!`
      );
      if (soundAlertEnabled) Predictor.playAlertPing("intercept");
    } else if (msg.type === "ROLL_COMPLETED") {
      loggedRollsCount = msg.rollNumber;
      if (autoAdvanceRoll) {
        targetRollNumber = loggedRollsCount + 1;
      }
      customDraftColors = [];
      renderAllPredictorViews();
    } else if (msg.type === "SESSION_INIT" || msg.type === "SESSION_CHANGED") {
      if (msg.diceCount) currentDiceCount = msg.diceCount;
      loggedRollsCount = msg.rollCount || 0;
      targetRollNumber = loggedRollsCount + 1;
      renderAllPredictorViews();
    }
  }

  function initPredictorUI() {
    // Populate 1-100 Dice options in predictor select
    const sel = document.getElementById("predictorDiceCountSelect");
    if (sel) {
      let optsHtml = `<option value="auto">⚡ AUTO-DETECT (4 DICE)</option>`;
      for (let i = 1; i <= 100; i++) {
        optsHtml += `<option value="${i}" ${i === 4 ? 'selected="selected"' : ""}>${i} DICE</option>`;
      }
      sel.innerHTML = optsHtml;
    }

    // Listen to local & cross-tab sync events
    window.addEventListener("offlinedice:sync", (e) => handleSyncMessage(e.detail));
    if (typeof BroadcastChannel !== "undefined") {
      try {
        const ch = new BroadcastChannel("offlinedice_sync_channel");
        ch.onmessage = (ev) => handleSyncMessage(ev.data);
      } catch (e) {}
    }

    // Enter key on ID input
    const inputEl = document.getElementById("predictorIdInput");
    if (inputEl) {
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          window.applyPredictorGameId(inputEl.value);
        }
      });
    }

    // Check URL params for initial mode or id
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
      // Wait briefly for 6_script.js Ee() to initialize the live session ID
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
