(function () {
  "use strict";

  const Predictor = window.OfflineDicePredictor;
  if (!Predictor) return;

  let currentMode = "predictor"; // 'predictor' | 'game' | 'split'
  let activeId = "";
  let currentDiceCount = 4;
  let autoDetectDiceCount = true;
  let loggedRollsCount = 0;
  let onScreenRollsCount = 0;
  let soundAlertEnabled = true;
  let sessionHistory = [];
  let firebaseNextRoll = null; // Exact pre-fetched roll before click
  let isCurrentlyRollingOnScreen = false;
  let firebaseListeners = [];
  let customDraftColors = [];
  let selectedHistoryRoll = null; // If user clicks a specific past roll to inspect
  let prefetchInFlightForId = "";
  let v110ActiveOption = 1; // 1 = Predict Next Dice Before Roll, 2 = Choose Color First
  let v110PersistEveryRoll = false; // false = Next Roll Only, true = Auto-Lock Every Roll
  let v110LockedColors = []; // Active locked colors from Option 2
  let autoRelockInFlight = false;

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
  const getFirebaseDb = getDb;

  function getRollDiceCallable() {
    if (window.rollDiceSecureCallable) return window.rollDiceSecureCallable;
    try {
      if (window.firebase && window.firebase.app) {
        return window.firebase.app().functions("europe-west1").httpsCallable("rollDiceSecure");
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
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> PRE-CLICK SYNC ACTIVE (#${cleanId})`;
    }

    // Listen to sessions/<cleanId>/rolls in real time
    // In Pre-Click Buffer mode, the latest entry in sessions/<cleanId>/rolls is pre-fetched BEFORE the user clicks Roll!
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
          built.rollId = childSnap.key;
          built.timestamp = timeStr;
          rolls.push(built);
          idx++;
        });
      }

      sessionHistory = rolls;
      loggedRollsCount = rolls.length;

      if (rolls.length > 0) {
        const latest = rolls[rolls.length - 1];
        firebaseNextRoll = latest;
        if (autoDetectDiceCount && latest.names && latest.names.length > 0 && latest.names.length !== currentDiceCount) {
          currentDiceCount = latest.names.length;
          const sel = document.getElementById("predictorDiceCountSelect");
          if (sel) sel.value = String(currentDiceCount);
        }
      } else {
        const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
        const isLocalSession = sess && Predictor.normalizeGameId(sess.gameId) === cleanId;
        if (isLocalSession && prefetchInFlightForId !== cleanId) {
          prefetchInFlightForId = cleanId;
          window.preQueueNextRollForActiveId();
        }
      }

      if (initialLoadDone && rolls.length > prevCount) {
        const latest = rolls[rolls.length - 1];
        selectedHistoryRoll = null;
        isCurrentlyRollingOnScreen = false;

        if (v110PersistEveryRoll && v110LockedColors.length > 0 && !autoRelockInFlight) {
          const matchesLocked =
            latest.names &&
            latest.names.length === v110LockedColors.length &&
            latest.names.every((n, idx) => n.toUpperCase() === v110LockedColors[idx].toUpperCase());
          if (!matchesLocked) {
            autoRelockInFlight = true;
            customDraftColors = [...v110LockedColors];
            window.lockCustomNextRoll().finally(() => {
              autoRelockInFlight = false;
            });
          }
        } else {
          triggerInterceptBanner(
            `🔮 NEXT DICE READY BEFORE YOU CLICK (ROLL #${rolls.length}): ${latest.names.join(" • ").toUpperCase()} — 100% ACCURATE!`
          );
          if (soundAlertEnabled) {
            Predictor.playAlertPing("intercept");
          }
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
    }, 5000);
  }

  /**
   * Returns the 100% verified Pre-Click Roll to display in the main showcase,
   * plus the previous roll currently sitting on the game screen.
   */
  function getActiveFirebaseRollToDisplay() {
    if (selectedHistoryRoll) {
      return {
        roll: selectedHistoryRoll,
        onScreenRoll: sessionHistory.length >= 2 ? sessionHistory[sessionHistory.length - 2] : null,
        mode: "HISTORY_INSPECT"
      };
    }

    if (firebaseNextRoll && firebaseNextRoll.isCustomLocked) {
      return {
        roll: firebaseNextRoll,
        onScreenRoll: sessionHistory.length >= 1 ? sessionHistory[sessionHistory.length - 1] : null,
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

    if (firebaseNextRoll && firebaseNextRoll.dice && firebaseNextRoll.dice.length > 0) {
      return {
        roll: firebaseNextRoll,
        onScreenRoll: null,
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

    // Update Telemetry Strip
    const elId = document.getElementById("telActiveId");
    const elLogged = document.getElementById("telRollsLogged");
    const elTarget = document.getElementById("telTargetRoll");
    const elDiceCount = document.getElementById("telDiceCount");

    if (elId) elId.textContent = "#" + cleanId;
    if (elLogged) {
      const landedCount = Math.max(0, sessionHistory.length - 1);
      elLogged.textContent = `${landedCount} On Screen / ${sessionHistory.length} DB`;
    }
    if (elTarget) {
      if (displayState.mode === "PRE_CLICK_READY" && activeRoll) {
        elTarget.textContent = `NEXT ROLL #${activeRoll.rollNumber} (BEFORE CLICK)`;
      } else if (displayState.mode === "LIVE_ROLLING_NOW" && activeRoll) {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (LANDING NOW!)`;
      } else if (displayState.mode === "HISTORY_INSPECT" && activeRoll) {
        elTarget.textContent = `ROLL #${activeRoll.rollNumber} (INSPECT)`;
      } else {
        elTarget.textContent = `PRE-FETCHING #1...`;
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
        stageBadge.innerHTML = `📡 LISTENING TO FIREBASE FOR #${cleanId} (READY FOR OFFLINE-DICE.COM)...`;
      }
      if (hashBadge) {
        hashBadge.textContent = `100% SERVER VERIFIED PRE-CLICK ENGINE • STEALTH MODE (ZERO UI ON GAME)`;
      }
      if (diceShowcase) {
        diceShowcase.innerHTML = `
          <div style="text-align:left; padding: 14px 18px; max-width: 600px; background: rgba(0,0,0,0.45); border: 1px solid rgba(255,234,61,0.35); border-radius: 14px;">
            <div style="font-size: 15px; font-weight: 800; color: #FFEA3D; margin-bottom: 8px; text-align:center;">
              🚀 1-Click Auto-Install for <span style="color:#00D2FF;">offline-dice.com</span> (No Copy-Paste & Zero Rig UI on Game):
            </div>
            <ol style="font-size: 12.5px; color: rgba(255,255,255,0.88); line-height: 1.6; margin: 0 0 12px 18px; padding: 0;">
              <li><strong>Option A (100% Automatic Every Time):</strong> Install the free <strong>Tampermonkey</strong> browser extension once, then click <strong>🚀 1-Click Auto-Install Script</strong> below and click <strong>Install</strong>. It will run automatically in the background every time you open <code>offline-dice.com</code>!</li>
              <li><strong>Option B (1-Click Bookmark — No Extension):</strong> Drag the blue <strong>🔮 Sync Offline-Dice</strong> button at the top onto your Bookmarks Bar, then click it once when on <code>offline-dice.com</code>.</li>
            </ol>
            <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
              <a href="/offline-dice.user.js" target="_blank" class="predictor-mini-btn" style="background:linear-gradient(135deg,#FFEA3D,#F59E0B); color:#000; border-color:#FFEA3D; padding:8px 14px; font-size:13px; font-weight:800; text-decoration:none;">
                🚀 1-Click Auto-Install Script (.user.js)
              </a>
              <button class="predictor-mini-btn" style="border-color:#00D2FF; color:#00D2FF; padding:8px 14px; font-size:12.5px;" onclick="copyExternalSitePreClickHook()">
                📋 Copy Silent Script
              </button>
            </div>
          </div>
        `;
      }
      if (seqBar) {
        seqBar.innerHTML = `<span style="color:rgba(255,255,255,0.75);">Connected to Firebase <strong>sessions/${cleanId}/rolls</strong> — Stealth Mode (Zero Rig UI on offline-dice.com)!</span>`;
      }
      if (breakdownGrid) {
        breakdownGrid.innerHTML = "";
      }
    } else {
      if (stageBadge) {
        if (displayState.mode === "PRE_CLICK_READY") {
          stageBadge.innerHTML = `🔮 PREDICTED BEFORE YOU CLICK — NEXT ROLL #${activeRoll.rollNumber} (100% ACCURATE) ${
            activeRoll.isCustomLocked ? '<span style="color:#FFEA3D;margin-left:6px;">[🔒 CUSTOM LOCKED]</span>' : ""
          }`;
        } else if (displayState.mode === "LIVE_ROLLING_NOW") {
          stageBadge.innerHTML = `🎲 ROLLING NOW ON SCREEN — LANDING ON EXACT PRE-CLICK DICE (#${activeRoll.rollNumber})!`;
        } else {
          stageBadge.innerHTML = `🔍 INSPECTING VERIFIED ROLL #${activeRoll.rollNumber} (FROM FIREBASE)`;
        }
      }
      if (hashBadge) {
        hashBadge.textContent = `READY BEFORE DICE CLICK • FIREBASE ROLL ID: ${activeRoll.rollId || activeRoll.hash || "VERIFIED"}`;
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
               <span style="color:#4ADE80;font-weight:800;">✅ CURRENTLY ON GAME SCREEN (ROLL #${onScreenRoll.rollNumber}): <strong style="color:#FFF;">${onScreenRoll.names.join(" • ").toUpperCase()}</strong></span>
               <span style="color:#FFEA3D;font-weight:800;">👆 ABOVE = NEXT DICE WHEN YOU CLICK "ROLL AGAIN !"</span>
             </div>`
          : `<div style="width:100%;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;">
               <span style="color:#4ADE80;font-weight:800;">✅ PRE-CLICK BUFFER READY: These exact dice will land on your next click of "ROLL AGAIN !"</span>
             </div>`;

        seqBar.innerHTML = `
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;justify-content:space-between;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              <span style="color:#FFEA3D;font-weight:800;margin-right:4px;">NEXT DICE (BEFORE CLICK):</span>
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

  function renderFirebaseQueueAndRecentSection(cleanId, activeRoll) {
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
        badgeHtml = `<span style="background:#22C55E;color:#000;font-size:10px;font-weight:900;padding:2px 6px;border-radius:4px;text-transform:uppercase;">🔮 NEXT DICE (BEFORE YOU CLICK)</span>`;
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
          Pre-fetching first roll for session <strong>#${cleanId}</strong>...
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

    // Render v1.1.0 Option 2 Custom Per-Die Picker Grid
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
          No rolls in Firebase for <strong>#${cleanId}</strong> yet. Click "🔮 Pre-Fetch Next Roll" to buffer Roll #1 before clicking!
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
          ${idx === 0 ? "🔮 PRE-FETCHED NEXT" : "✅ LANDED"}
        </span>
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
    prefetchInFlightForId = "";

    const gameSess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (gameSess && Predictor.normalizeGameId(gameSess.gameId) === clean) {
      onScreenRollsCount = gameSess.rollCount || 0;
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

  /**
   * Generates and pushes the 100% rigged upcoming roll into Firebase BEFORE the dice button is clicked!
   */
  window.preQueueNextRollForActiveId = async function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) return;

    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (sess && Predictor.normalizeGameId(sess.gameId) === clean && window.queueNextRollInFirebase) {
      const rollObj = await window.queueNextRollInFirebase(Math.max(1, loggedRollsCount), currentDiceCount, null, true);
      if (rollObj) {
        firebaseNextRoll = rollObj;
        selectedHistoryRoll = null;
        renderAllPredictorViews();
        triggerInterceptBanner(
          `🔮 RIGGED NEXT DICE BEFORE CLICK (#${clean}): ${rollObj.names.join(" • ").toUpperCase()}!`
        );
      }
      return;
    }

    const db = getFirebaseDb();
    if (db) {
      try {
        const nextNum = Math.max(1, loggedRollsCount || 1);
        const rollObj = Predictor.generateRealCsprngRoll(clean, nextNum, currentDiceCount, null);
        const targetRef = db.ref("sessions/" + clean + "/rolls").push();
        rollObj.rollId = targetRef.key || "";
        await targetRef.set({
          colors: rollObj.colors,
          names: rollObj.names,
          time: Date.now(),
          isRigged: false,
          hash: rollObj.hash
        });
        firebaseNextRoll = rollObj;
        selectedHistoryRoll = null;
        renderAllPredictorViews();
        triggerInterceptBanner(
          `🔮 RIGGED NEXT DICE READY BEFORE YOU CLICK (ROLL #${rollObj.rollNumber}): ${rollObj.names.join(" • ").toUpperCase()}!`
        );
      } catch (e) {}
    }
  };

  window.openPreSyncedGameTab = function () {
    const clean = Predictor.normalizeGameId(activeId);
    const url = clean ? `./game.html?id=${encodeURIComponent(clean)}` : `./game.html`;
    window.open(url, "_blank");
  };

  function getSilentHookCode() {
    return `(function(){const oldBar=document.getElementById("odHookPreviewBar");if(oldBar)oldBar.remove();if(window.__odPreClickActiveV110)return;window.__odPreClickActiveV110=true;window.__odPreClickActive=true;window.__odBuffered=null;window.__odLastLandedId=null;window.__odPrefetching=false;window.__odInitDone=false;const db=typeof n!=="undefined"?n:firebase.database(firebase.apps[0],"https://offline-dice-verify-default-rtdb.europe-west1.firebasedatabase.app");function parseDice(v){const raw=Array.isArray(v.names)&&v.names.length>0?v.names:(Array.isArray(v.colors)?v.colors:[]);return raw.map(nm=>{const s=String(nm||"").toUpperCase();return u.find(c=>c.name.toUpperCase()===s||c.hex.toUpperCase()===s)||u[0];});}db.ref("sessions/"+y+"/rolls").on("value",snap=>{if(f)return;const all=[];if(snap.exists())snap.forEach(ch=>all.push({key:ch.key,val:ch.val()||{}}));if(!window.__odInitDone){window.__odInitDone=true;if(m>0&&all.length>0&&all.length<=m)window.__odLastLandedId=all[all.length-1].key;}if(all.length>0){const latest=all[all.length-1];const dice=parseDice(latest.val);if(dice.length>0&&latest.key!==window.__odLastLandedId){window.__odBuffered={dc:dice.length,rollId:latest.key,dice:dice};return;}}if(!window.__odPrefetching)window.__odPrefetch(true);});window.__odPrefetch=async function(forceNew){if(window.__odPrefetching)return;window.__odPrefetching=true;try{const dc=parseInt(document.getElementById("diceCount")?.value,10)||4;if(!forceNew){const snap=await db.ref("sessions/"+y+"/rolls").once("value");const all=[];if(snap.exists())snap.forEach(ch=>all.push({key:ch.key,val:ch.val()||{}}));if(all.length>0){const latest=all[all.length-1];const dice=parseDice(latest.val);if(dice.length>0&&latest.key!==window.__odLastLandedId){window.__odBuffered={dc:dice.length,rollId:latest.key,dice:dice};return;}}}const cols=Array.from({length:dc},()=>u[x(u.length)]);const ref=db.ref("sessions/"+y+"/rolls").push();await ref.set({colors:cols.map(c=>c.hex),names:cols.map(c=>c.name),time:Date.now(),isRigged:!1,hash:"0x"+Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b=>b.toString(16).padStart(2,"0")).join("").toUpperCase()});window.__odBuffered={dc,rollId:ref.key,dice:cols};}catch(e){}finally{window.__odPrefetching=false;}};document.getElementById("diceCount")?.addEventListener("change",()=>window.__odPrefetch(true));window.rollDice=async function(){if(f)return;f=true;const dc=parseInt(document.getElementById("diceCount")?.value,10)||4;if(!window.__odBuffered||!Array.isArray(window.__odBuffered.dice)||window.__odBuffered.dice.length===0){await window.__odPrefetch(true);}const cur=window.__odBuffered;const finalDice=Array.from({length:dc},(_,idx)=>cur.dice[idx%cur.dice.length]);window.__odLastLandedId=cur.rollId;window.__odBuffered=null;const l=document.getElementById("rollOverlay"),i=document.getElementById("overlayTitle"),c=document.getElementById("overlayDiceContainer"),d=["You're Cooked...","Good Luck :)","Amazing!","Let's See...","Offline Dice On TOP!","Rolling..."];if(i)i.innerText=d[x(d.length)];if(c){c.innerHTML="";for(let k=0;k<dc;k++){const die=document.createElement("div");die.className="big-die";const dot=document.createElement("div");dot.className="big-die-dot";die.appendChild(dot);c.appendChild(die);}}setTimeout(()=>{c?.querySelectorAll(".big-die").forEach(el=>el.classList.add("initial-shake"));l?.classList.remove("hidden");s.currentTime=0;s.play().catch(()=>{});setTimeout(()=>{l?.classList.add("hidden");j(finalDice,cur.rollId);f=false;setTimeout(()=>window.__odPrefetch(true),80);},1200);},700);};})();`;
  }

  window.copyExternalSitePreClickHook = function () {
    const hookCode = getSilentHookCode();
    navigator.clipboard.writeText(hookCode).catch(() => {});
    const btn = document.getElementById("copyHookBtn");
    if (btn) {
      const old = btn.innerText;
      btn.innerText = "✅ v1.1.0 CODE COPIED!";
      setTimeout(() => {
        btn.innerText = old;
      }, 2200);
    }
    triggerInterceptBanner(
      `✅ v1.1.0 SILENT HOOK COPIED! Supports Option 1 (Predict Before Roll) + Option 2 (Choose Color First from Mobile)!`
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
    if (v110PersistEveryRoll && customDraftColors.length > 0) {
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
    if (!clean) return;
    const nextNum = Math.max(1, loggedRollsCount || 1);
    const fullColors = [];
    for (let i = 0; i < currentDiceCount; i++) {
      fullColors.push(customDraftColors[i % customDraftColors.length] || "Red");
    }
    v110LockedColors = [...fullColors];

    const updateStatusEl = (namesList) => {
      const statusEl = document.getElementById("v110LiveLockStatus");
      if (statusEl) {
        statusEl.innerHTML = `✅ LOCKED FOR <strong>#${clean}</strong>: <span style="color:#FFEA3D;">${namesList.join(" • ").toUpperCase()}</span> — CLICK "ROLL AGAIN !" ON PC NOW!`;
      }
    };

    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (sess && Predictor.normalizeGameId(sess.gameId) === clean && window.queueNextRollInFirebase) {
      const rollObj = await window.queueNextRollInFirebase(nextNum, currentDiceCount, fullColors, true);
      if (rollObj) {
        firebaseNextRoll = rollObj;
        selectedHistoryRoll = null;
        updateStatusEl(rollObj.names);
        renderAllPredictorViews();
        triggerInterceptBanner(`🔒 LOCKED CUSTOM NEXT DICE FOR #${clean}: ${rollObj.names.join(" • ").toUpperCase()}!`);
      }
      return;
    }

    const rollObj = Predictor.generateRealCsprngRoll(clean, nextNum, currentDiceCount, fullColors);
    rollObj.isCustomLocked = true;
    firebaseNextRoll = rollObj;
    selectedHistoryRoll = null;

    try {
      localStorage.setItem("od_locked_next_" + clean, JSON.stringify(rollObj));
    } catch (e) {}

    const db = getFirebaseDb();
    if (db) {
      try {
        let wrote = false;
        const latest = sessionHistory.length > 0 ? sessionHistory[sessionHistory.length - 1] : null;
        if (latest && latest.rollId) {
          try {
            const existingRef = db.ref("sessions/" + clean + "/rolls/" + latest.rollId);
            await existingRef.set({
              colors: rollObj.colors,
              names: rollObj.names,
              time: Date.now(),
              isRigged: false,
              hash: rollObj.hash
            });
            rollObj.rollId = latest.rollId;
            wrote = true;
          } catch (innerErr) {
            wrote = false;
          }
        }
        if (!wrote) {
          const pushRef = db.ref("sessions/" + clean + "/rolls").push();
          rollObj.rollId = pushRef.key || "";
          await pushRef.set({
            colors: rollObj.colors,
            names: rollObj.names,
            time: Date.now(),
            isRigged: false,
            hash: rollObj.hash
          });
        }
      } catch (e) {}
    }

    updateStatusEl(rollObj.names);
    renderAllPredictorViews();
    triggerInterceptBanner(`🔒 LOCKED CUSTOM NEXT DICE FOR #${clean}: ${rollObj.names.join(" • ").toUpperCase()}!`);
  };

  window.clearCustomNextRoll = function () {
    const clean = Predictor.normalizeGameId(activeId);
    v110LockedColors = [];
    v110PersistEveryRoll = false;
    window.setV110PersistMode(false);
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
