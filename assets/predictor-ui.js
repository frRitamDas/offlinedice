(function () {
  "use strict";

  const Predictor = window.OfflineDicePredictor;
  if (!Predictor) return;

  const API_ENDPOINTS = [
    "https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig",
    "https://offlinedicerdd.vercel.app/api/rig",
    "/api/rig"
  ];

  let currentMode = "predictor"; // 'predictor' | 'game' | 'split'
  let activeId = "";
  let currentDiceCount = 4;
  let autoDetectDiceCount = true;
  let loggedRollsCount = 1;
  let onScreenRollsCount = 0;
  let soundAlertEnabled = true;
  let sessionHistory = [];
  let firebaseNextRoll = null;
  let isCurrentlyRollingOnScreen = false;
  let customDraftColors = ["Red", "Red", "Red", "Red"];
  let selectedHistoryRoll = null;
  let v110ActiveOption = 1; // 1 = Predict Next Dice Before Roll, 2 = Choose Color First
  let v110PersistEveryRoll = false;
  let v110LockedColors = [];
  let apiPollTimer = null;
  let lastSeenApiRollNum = 0;
  let apiRequestInFlight = false;
  let lastAutoDetectedPcId = "";
  let lastSeenPingTs = 0;
  let pcWatcherInitialized = false;
  let pcWatcherTimer = null;
  let toastHideTimer = null;

  function showMainSiteSyncToast(sessionId, customLabel) {
    const clean = Predictor.normalizeGameId(sessionId);
    const msg = customLabel || `v1.3.1 Synced! ID: ${clean}`;

    // Show the top green #successToast on offlinedicerdd.vercel.app (moved from offline-dice.com)
    const toastEl = document.getElementById("successToast");
    if (toastEl) {
      toastEl.innerText = msg;
      toastEl.classList.add("show");
    }

    // Also show the floating bottom pill popup on offlinedicerdd.vercel.app
    let popEl = document.getElementById("odPredictorSyncPopup");
    if (!popEl) {
      popEl = document.createElement("div");
      popEl.id = "odPredictorSyncPopup";
      popEl.className = "od-sync-popup";
      document.body.appendChild(popEl);
    }
    popEl.textContent = `✅ ${msg}`;
    popEl.classList.add("show");

    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove("show");
      if (popEl) popEl.classList.remove("show");
    }, 3400);
  }

  async function callRigApi(paramsObj) {
    const action = paramsObj.action || "status";
    const clean =
      action === "latest_pc"
        ? "__LATEST_PC__"
        : Predictor.normalizeGameId(paramsObj.sessionId || activeId);
    if (!clean) return null;

    const dc = paramsObj.diceCount || currentDiceCount || 4;
    let qs =
      "?action=" +
      encodeURIComponent(action) +
      "&sessionId=" +
      encodeURIComponent(clean) +
      "&diceCount=" +
      encodeURIComponent(dc) +
      "&_t=" +
      Date.now();

    if (Array.isArray(paramsObj.lockedNames) && paramsObj.lockedNames.length > 0) {
      qs += "&colors=" + encodeURIComponent(paramsObj.lockedNames.join(","));
    }
    if (paramsObj.persistEveryRoll !== undefined) {
      qs += "&persist=" + (paramsObj.persistEveryRoll ? "1" : "0");
    }

    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      try {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tId = ctrl ? setTimeout(() => ctrl.abort(), 3000) : null;
        const resp = await fetch(API_ENDPOINTS[i] + qs, {
          method: "GET",
          mode: "cors",
          cache: "no-store",
          signal: ctrl ? ctrl.signal : undefined
        });
        if (tId) clearTimeout(tId);
        if (resp && resp.ok) {
          const ct = resp.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const data = await resp.json();
            if (data && data.ok) return data;
          }
        }
      } catch (err) {}
    }
    return null;
  }

  window.autoDetectLatestPcSession = async function (showAlertIfMissing) {
    const res = await callRigApi({ action: "latest_pc" });
    if (res && res.ok && res.latestPcSessionId) {
      const pcId = Predictor.normalizeGameId(res.latestPcSessionId);
      const pingTs = Number(res.pingTs) || 0;
      if (pcId) {
        lastAutoDetectedPcId = pcId;
        if (pingTs > 0) lastSeenPingTs = pingTs;
        if (Predictor.normalizeGameId(activeId) !== pcId) {
          window.applyPredictorGameId(pcId);
          showMainSiteSyncToast(pcId);
          triggerInterceptBanner(`🎯 v1.3.1 Synced! ID: ${pcId}`);
        } else if (showAlertIfMissing) {
          showMainSiteSyncToast(pcId);
          triggerInterceptBanner(`✅ v1.3.1 Synced! ID: ${pcId}`);
        }
        return pcId;
      }
    }
    if (showAlertIfMissing) {
      alert(
        "No active PC bookmark session detected yet.\n\n1. Open offline-dice.com on your PC.\n2. Click the v1.3.1 Bookmark once on offline-dice.com (or type your Session ID directly into the ID box)."
      );
    }
    return "";
  };

  async function checkAndSyncLatestPcSession() {
    const res = await callRigApi({ action: "latest_pc" });
    if (!res || !res.ok || !res.latestPcSessionId) {
      if (!pcWatcherInitialized) pcWatcherInitialized = true;
      return;
    }

    const pcId = Predictor.normalizeGameId(res.latestPcSessionId);
    const pingTs = Number(res.pingTs) || 0;
    if (!pcId) return;

    if (!pcWatcherInitialized) {
      pcWatcherInitialized = true;
      lastAutoDetectedPcId = pcId;
      if (pingTs > 0) lastSeenPingTs = pingTs;

      if (!activeId) {
        window.applyPredictorGameId(pcId);
        showMainSiteSyncToast(pcId);
        triggerInterceptBanner(`🎯 v1.3.1 Synced! ID: ${pcId}`);
      }
      return;
    }

    const idChanged = pcId !== lastAutoDetectedPcId;
    const pingUpdated = pingTs > 0 && pingTs !== lastSeenPingTs;

    if (idChanged || pingUpdated) {
      lastAutoDetectedPcId = pcId;
      if (pingTs > 0) lastSeenPingTs = pingTs;

      if (Predictor.normalizeGameId(activeId) !== pcId) {
        window.applyPredictorGameId(pcId);
      } else {
        syncSessionWithRigApi(pcId, false);
      }

      if (res.session) {
        const sess = res.session;
        const isLocked = Boolean(sess.is_locked) && Array.isArray(sess.locked_names) && sess.locked_names.length > 0;
        const activeNames = isLocked ? sess.locked_names : (sess.predicted_names || []);
        applyApiDataToPredictorState(
          pcId,
          {
            ok: true,
            sessionId: pcId,
            mode: isLocked ? "LOCKED" : "PREDICTED",
            activeNames: activeNames,
            state: sess
          },
          false
        );
      }

      showMainSiteSyncToast(pcId);
      triggerInterceptBanner(`🔄 v1.3.1 Synced! ID: ${pcId}`);
    }
  }

  function startContinuousPcWatcher() {
    if (pcWatcherTimer) clearInterval(pcWatcherTimer);
    checkAndSyncLatestPcSession();
    pcWatcherTimer = setInterval(() => {
      checkAndSyncLatestPcSession();
    }, 800);
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

    const existingIdx = sessionHistory.findIndex((r) => r.rollNumber === rollNum);
    if (existingIdx >= 0) {
      sessionHistory[existingIdx] = builtRoll;
    } else {
      sessionHistory.push(builtRoll);
      if (sessionHistory.length > 25) sessionHistory.shift();
    }

    const connBadge = document.getElementById("predConnectionBadge");
    if (connBadge) {
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> LIVE SYNC #${cleanId} • ${
        isLocked ? "🔒 LOCKED" : "🔮 PREDICTING"
      }`;
    }

    const statusEl = document.getElementById("v110LiveLockStatus");
    if (statusEl) {
      if (isLocked) {
        statusEl.innerHTML = `✅ LOCKED FOR <strong>#${cleanId}</strong> (ROLL #${rollNum}): <span style="color:#FFEA3D;">${activeNames
          .join(" • ")
          .toUpperCase()}</span> — CLICK "ROLL AGAIN !" ON OFFLINE-DICE.COM NOW!`;
      } else {
        statusEl.innerHTML = `🔮 NEXT ROLL #${rollNum} FOR <strong>#${cleanId}</strong>: <span style="color:#4ADE80;">${activeNames
          .join(" • ")
          .toUpperCase()}</span> (TAP ANY COLOR BELOW TO LOCK CUSTOM COLORS)`;
      }
    }

    if (notifyOnNewRoll && isRollAdvance) {
      isCurrentlyRollingOnScreen = false;
      selectedHistoryRoll = null;
      triggerInterceptBanner(
        `🎲 ROLL #${rollNum - 1} LANDED ON PC! NEXT ROLL #${rollNum} READY: ${activeNames.join(" • ").toUpperCase()}`
      );
      if (soundAlertEnabled) {
        Predictor.playAlertPing("intercept");
      }
    }

    renderAllPredictorViews();
  }

  function stopPolling() {
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

  function connectSessionToRigApi(cleanId) {
    stopPolling();
    if (!cleanId) return;

    const connBadge = document.getElementById("predConnectionBadge");
    if (connBadge) {
      connBadge.innerHTML = `<span class="predictor-status-dot"></span> CONNECTING #${cleanId}...`;
    }

    lastSeenApiRollNum = 0;
    syncSessionWithRigApi(cleanId, false);

    apiPollTimer = setInterval(async () => {
      const curClean = Predictor.normalizeGameId(activeId);
      if (curClean === cleanId) {
        await syncSessionWithRigApi(cleanId, true);
      }
    }, 1000);
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

  function getActiveRollToDisplay() {
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

    return { roll: null, onScreenRoll: null, mode: "FETCHING_PRE_CLICK" };
  }

  function renderAllPredictorViews() {
    const cleanId = Predictor.normalizeGameId(activeId) || "NONE";
    const displayState = getActiveRollToDisplay();
    const activeRoll = displayState.roll;

    const stageBadge = document.getElementById("predStageRollBadge");
    const hashBadge = document.getElementById("predStageHash");
    const diceShowcase = document.getElementById("predDiceShowcase");
    const seqBar = document.getElementById("predSequenceText");
    const breakdownGrid = document.getElementById("predColorBreakdown");

    if (!activeRoll) {
      if (stageBadge) {
        stageBadge.innerHTML =
          cleanId === "NONE"
            ? `📡 WAITING FOR SESSION ID (CLICK BOOKMARK ON PC OR ENTER ID ABOVE)`
            : `📡 SYNCING SESSION #${cleanId}...`;
      }
      if (hashBadge) {
        hashBadge.textContent = `v1.3.0 DIRECT API SYNC • ZERO RIG UI ON OFFLINE-DICE.COM`;
      }
      if (diceShowcase) {
        diceShowcase.innerHTML = `
          <div style="grid-column: 1 / -1; text-align:left; padding: 16px 20px; background: rgba(0,0,0,0.45); border: 1.5px solid rgba(0,210,255,0.35); border-radius: 14px;">
            <div style="font-size: 15px; font-weight: 800; color: #FFEA3D; margin-bottom: 8px;">
              🚀 Quick 3-Step Setup for <span style="color:#00D2FF;">offline-dice.com</span> (v1.3.0):
            </div>
            <ol style="font-size: 13px; color: rgba(255,255,255,0.88); line-height: 1.65; margin: 0 0 12px 18px; padding: 0;">
              <li>Drag the blue <strong>🔖 Drag v1.3.0 Bookmark to PC Bar</strong> button above onto your PC browser's Bookmarks Bar (replace any older bookmark).</li>
              <li>Open <code>offline-dice.com</code> on your PC and click that bookmark once — you'll see a green <strong>"v1.3.0 Synced!"</strong> toast on <code>offline-dice.com</code>.</li>
              <li>This page will <strong>auto-detect your PC Session ID</strong> (or you can type it above). Choose <strong>Option 1</strong> to see upcoming dice, or <strong>Option 2</strong> to lock any color before rolling!</li>
            </ol>
          </div>
        `;
      }
      if (seqBar) {
        seqBar.innerHTML = `<span style="color:rgba(255,255,255,0.72);">Click <strong>🎯 Auto-Detect PC ID</strong> above after clicking the v1.3.0 bookmark on <code>offline-dice.com</code>!</span>`;
      }
      if (breakdownGrid) {
        breakdownGrid.innerHTML = "";
      }
    } else {
      if (stageBadge) {
        stageBadge.innerHTML = activeRoll.isCustomLocked
          ? `🔒 LOCKED FOR #${cleanId} (ROLL #${activeRoll.rollNumber}) — WILL LAND ON THESE EXACT COLORS`
          : `🔮 NEXT ROLL #${activeRoll.rollNumber} FOR #${cleanId} (BEFORE YOU CLICK ROLL AGAIN)`;
      }
      if (hashBadge) {
        hashBadge.textContent = `SESSION #${cleanId} • STATUS: ${
          activeRoll.isCustomLocked ? "CUSTOM COLOR LOCK ACTIVE" : "LIVE PREDICTION READY"
        }`;
      }

      if (diceShowcase) {
        diceShowcase.innerHTML = "";
        const frag = document.createDocumentFragment();
        activeRoll.dice.forEach((die) => {
          const card = document.createElement("div");
          card.className = "pred-die-card";
          card.style.borderColor = die.hex;
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
          .slice(0, 12)
          .map(
            (d) =>
              `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.55);padding:4px 9px;border-radius:7px;border:1px solid ${d.hex};"><strong style="color:rgba(255,255,255,0.65);">#${d.dieNumber}:</strong> <strong style="color:${d.hex};">${d.name.toUpperCase()}</strong></span>`
          )
          .join(" ");

        seqBar.innerHTML = `
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;justify-content:space-between;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
              <span style="color:#FFEA3D;font-weight:800;margin-right:4px;">${
                activeRoll.isCustomLocked ? "🔒 LOCKED OUTCOME:" : "🔮 NEXT OUTCOME:"
              }</span>
              ${seqHtml}
            </div>
            <span style="color:#4ADE80;font-weight:800;font-size:12.5px;">
              ✅ Ready on offline-dice.com
            </span>
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

    renderCustomLockerSlots(activeRoll);
    renderRecentQueueSection(cleanId);
  }

  function renderRecentQueueSection(cleanId) {
    const queueList = document.getElementById("predUpcomingQueueList");
    const countBadge = document.getElementById("predHistoryCountBadge");
    if (countBadge) countBadge.textContent = `${sessionHistory.length} Rolls`;
    if (!queueList) return;
    queueList.innerHTML = "";

    const recentRolls = [...sessionHistory].reverse().slice(0, 8);
    recentRolls.forEach((r, idx) => {
      const isNext = idx === 0;
      const item = document.createElement("div");
      item.className = "upcoming-roll-item" + (isNext ? " is-next" : "");
      item.onclick = () => {
        selectedHistoryRoll = isNext ? null : r;
        renderAllPredictorViews();
      };
      const diceBoxes = r.dice
        .slice(0, 12)
        .map(
          (d) => `
          <div class="upcoming-die-box" style="background-color: ${d.hex};" title="Die #${d.dieNumber}: ${d.name}">
            <div class="upcoming-die-dot"></div>
          </div>`
        )
        .join("");

      const badgeHtml = isNext
        ? `<span style="background:${
            r.isCustomLocked ? "#FFEA3D" : "#22C55E"
          };color:#000;font-size:10.5px;font-weight:900;padding:2px 7px;border-radius:5px;text-transform:uppercase;">${
            r.isCustomLocked ? "🔒 LOCKED NEXT ROLL" : "🔮 NEXT ON CLICK"
          }</span>`
        : `<span style="background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.75);font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:5px;">✅ ROLLED (${
            r.timestamp || ""
          })</span>`;

      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong style="font-size:13.5px;color:${isNext ? "#FFEA3D" : "#00D2FF"};">ROLL #${r.rollNumber}</strong>
          ${badgeHtml}
        </div>
        <div class="upcoming-mini-dice">${diceBoxes}</div>
        <div style="font-size:12.5px;color:#FFFFFF;font-weight:800;">
          ${r.names.slice(0, 6).join(" • ")}
        </div>
      `;
      queueList.appendChild(item);
    });

    if (queueList.children.length === 0) {
      queueList.innerHTML = `
        <div style="padding:14px;text-align:center;color:rgba(255,255,255,0.55);font-size:12.5px;">
          No rolls queued yet — connect your Session ID above to start.
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
          return `<button type="button" class="v110-swatch-btn ${isAct}" style="background:${sc.hex};" onclick="setV110SingleDieColor(${idx}, '${sc.name}')" title="Set Die #${
            idx + 1
          } to ${sc.name}">${sc.name.charAt(0)}</button>`;
        }).join("");

        card.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
            <span style="font-size:11px; font-weight:800; color:rgba(255,255,255,0.72);">DIE #${idx + 1}</span>
            <strong style="font-family:'Fredoka',sans-serif; font-size:13px; color:${c.hex};">${c.name.toUpperCase()}</strong>
          </div>
          <div style="width:48px; height:48px; border-radius:12px; background:${c.hex}; border:2.5px solid #fff; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.5);">
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

  window.applyPredictorGameId = function (newIdInput) {
    const inputEl = document.getElementById("predictorIdInput");
    const raw = newIdInput !== undefined ? newIdInput : inputEl ? inputEl.value : "";
    const clean = Predictor.normalizeGameId(raw);
    if (!clean) {
      alert("Please enter the Game ID from offline-dice.com (or click 🎯 Auto-Detect PC ID).");
      return;
    }
    activeId = clean;
    if (inputEl) inputEl.value = clean;
    selectedHistoryRoll = null;
    sessionHistory = [];
    loggedRollsCount = 1;
    firebaseNextRoll = null;
    customDraftColors = Array(Math.min(12, currentDiceCount)).fill("Red");

    connectSessionToRigApi(clean);
    renderAllPredictorViews();
  };

  window.preQueueNextRollForActiveId = async function () {
    const clean = Predictor.normalizeGameId(activeId);
    if (!clean) {
      alert("Please connect a Session ID first!");
      return;
    }

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
        `🔮 NEW PREDICTION SYNCED FOR #${clean}: ${(apiData.activeNames || []).join(" • ").toUpperCase()}!`
      );
    }
  };

  /**
   * Returns the v1.3.1 Silent Hook Code with ZERO literal '#' characters (\x23 used instead)
   * so bookmarklet URL encoding & execution works 100% reliably across all browsers.
   * - ZERO popup/toast on offline-dice.com when clicking the bookmark!
   * - Intercepts F5 / Ctrl+R / Cmd+R / Logo click on offline-dice.com to perform an instant
   *   in-place Session ID refresh without losing the bookmark script, and immediately sends
   *   pingEvent=1 so offlinedicerdd.vercel.app refreshes its Session ID and pops up
   *   "v1.3.1 Synced! ID: <newId>"!
   * - Observes #gameIdDisplay via MutationObserver so any ID change immediately syncs.
   */
  function getSilentHookCode() {
    return `(function(){var b=document.getElementById("odHookPreviewBar");if(b)b.remove();var st=document.getElementById("successToast");if(st)st.classList.remove("show");var EP=["https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig","https://offlinedicerdd.vercel.app/api/rig"];var PAL=[{name:"Red",hex:"\\x23FF0000"},{name:"Orange",hex:"\\x23FFA500"},{name:"Yellow",hex:"\\x23FFD700"},{name:"Green",hex:"\\x23008000"},{name:"Blue",hex:"\\x230000FF"},{name:"Purple",hex:"\\x23800080"}];window.__odRigState=window.__odRigState||null;window.__odBuffered=window.__odBuffered||null;window.__odForcedDice=null;window.__odRolling=false;window.__odLastSid=window.__odLastSid||"";function clean(s){return String(s||"").trim().toUpperCase().replace(new RegExp("^\\x23+"),"").replace(/[^A-Z0-9_-]/g,"");}function genSid(){try{if(typeof R==="function")return clean(R());}catch(e){}var ch="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",o="";for(var i=0;i<10;i++){var a=new Uint32Array(1);window.crypto.getRandomValues(a);o+=ch[a[0]%36];}return o;}function getSid(){var el=document.getElementById("gameIdDisplay");var tx=el?String(el.innerText||el.textContent||"").trim():"";if(tx&&tx.toUpperCase()!=="LOADING..."){var c=clean(tx);if(c)return c;}try{if(typeof y==="string"&&y.trim())return clean(y);}catch(e){}return "";}function getDc(){var el=document.getElementById("diceCount");return el?Math.min(100,Math.max(1,parseInt(el.value,10)||4)):4;}function getPal(){try{if(typeof u!=="undefined"&&Array.isArray(u)&&u.length===6)return u;}catch(e){}return PAL;}function mapDice(names,dc){var pal=getPal();var src=Array.isArray(names)&&names.length>0?names:["Red","Orange","Yellow","Green"];var out=[];for(var i=0;i<dc;i++){var raw=String(src[i%src.length]||"").trim().toUpperCase();var m=pal.find(function(c){return c.name.toUpperCase()===raw||c.hex.toUpperCase()===raw;})||pal[0];out.push({name:m.name,hex:m.hex});}return out;}async function callApi(act,ping){var sid=getSid();if(!sid)return null;var dc=getDc();var qs="?action="+encodeURIComponent(act)+"&sessionId="+encodeURIComponent(sid)+"&diceCount="+encodeURIComponent(dc)+"&source=pc"+(ping?"&pingEvent=1":"")+"&_t="+Date.now();for(var i=0;i<EP.length;i++){try{var r=await fetch(EP[i]+qs,{method:"GET",mode:"cors",cache:"no-store"});if(r&&r.ok){var d=await r.json();if(d&&d.ok)return d;}}catch(e){}}return null;}async function sync(force,ping){if(window.__odRolling&&!force)return;var d=await callApi("status",Boolean(ping));if(d&&d.ok){window.__odRigState=d;var dc=getDc();window.__odBuffered={dc:dc,rollId:"",mode:d.mode||"PREDICTED",dice:mapDice(d.activeNames,dc)};}}function domRender(finalDice){try{if(typeof W==="function")W();}catch(e){}var ct=document.getElementById("diceContainer");if(!ct)return;var fg=document.createDocumentFragment();finalDice.forEach(function(d){var w=document.createElement("div");w.className="die-wrapper";var de=document.createElement("div");de.className="die";de.style.setProperty("background-color",d.hex,"important");var dt=document.createElement("div");dt.className="die-dot";var lb=document.createElement("div");lb.className="die-label";lb.innerText=d.name;lb.style.setProperty("color",d.hex,"important");de.appendChild(dt);w.appendChild(de);w.appendChild(lb);fg.appendChild(w);});ct.innerHTML="";ct.appendChild(fg);try{if(typeof G==="function")G(finalDice);}catch(e){}}function refreshInPlace(){if(window.__odRolling)return;var ns=genSid();document.body.style.transition="opacity 0.1s ease";document.body.style.opacity="0.4";setTimeout(function(){document.body.style.opacity="1";},120);try{if(typeof y!=="undefined")y=ns;if(typeof m!=="undefined")m=0;if(typeof p!=="undefined"&&Array.isArray(p))p.length=0;if(typeof V==="function")V();}catch(e){}var idEl=document.getElementById("gameIdDisplay");if(idEl)idEl.innerText=ns;var rcEl=document.getElementById("rollsTodayCount");if(rcEl)rcEl.innerText="0";var hEl=document.getElementById("inlineHistoryList");if(hEl)hEl.innerHTML='<div style="color: \\x23aaa; text-align: center; font-weight: 500; padding: 10px;">Roll the dice to see your history!</div>';domRender(mapDice(["Red","Orange","Yellow","Green"],getDc()));try{if(typeof updateVerifyLink==="function")updateVerifyLink();}catch(e){}try{if(typeof n!=="undefined"&&n&&typeof n.ref==="function")n.ref("sessions/"+ns+"/status").set("active").catch(function(){});}catch(e){}window.__odLastSid=ns;sync(true,true);}function landDice(finalDice){window.__odForcedDice=finalDice;var ok=false;try{if(typeof window.j==="function"){var tj=window.j.__origJ||window.j;tj(finalDice,"");ok=true;}else if(typeof j==="function"){j(finalDice,"");ok=true;}}catch(e){}if(!ok){domRender(finalDice);var rc=document.getElementById("rollsTodayCount");if(rc)rc.innerText=String((parseInt(rc.innerText,10)||0)+1);}setTimeout(function(){var ct=document.getElementById("diceContainer");if(!ct)return;var lbs=ct.querySelectorAll(".die-label");var bad=lbs.length!==finalDice.length;if(!bad){lbs.forEach(function(el,idx){if(String(el.textContent||"").trim().toUpperCase()!==finalDice[idx].name.toUpperCase())bad=true;});}if(bad)domRender(finalDice);},40);}async function hookedRoll(){if(window.__odRolling)return;window.__odRolling=true;try{if(typeof f!=="undefined")f=true;}catch(e){}var dc=getDc();var sid=getSid();var cached=(window.__odRigState&&Array.isArray(window.__odRigState.activeNames)&&window.__odRigState.activeNames.length>0)?window.__odRigState.activeNames.slice():null;var cp=callApi("consume",false);var l=document.getElementById("rollOverlay"),i=document.getElementById("overlayTitle"),c=document.getElementById("overlayDiceContainer"),t=["You're Cooked...","Good Luck :)","Amazing!","Let's See...","Offline Dice On TOP!","Rolling..."];if(i)i.innerText=t[Math.floor(Math.random()*t.length)];if(c){c.innerHTML="";for(var k=0;k<dc;k++){var die=document.createElement("div");die.className="big-die";var dot=document.createElement("div");dot.className="big-die-dot";die.appendChild(dot);c.appendChild(die);}}setTimeout(function(){if(c)c.querySelectorAll(".big-die").forEach(function(el){el.classList.add("initial-shake");});if(l)l.classList.remove("hidden");try{if(typeof s!=="undefined"&&s){s.currentTime=0;s.play().catch(function(){});}}catch(e){}setTimeout(async function(){var res=null;try{res=await cp;}catch(e){}var names=(res&&Array.isArray(res.rollToLandNames)&&res.rollToLandNames.length>0)?res.rollToLandNames:(cached&&cached.length>0?cached:["Red","Red","Red","Red"]);var finalDice=mapDice(names,dc);if(res&&res.nextState){var ns=res.nextState;var lkd=Boolean(ns.is_locked)&&Array.isArray(ns.locked_names)&&ns.locked_names.length>0;var nxt=lkd?ns.locked_names:(ns.predicted_names||[]);window.__odRigState={ok:true,sessionId:sid,mode:lkd?"LOCKED":"PREDICTED",activeNames:nxt,state:ns};window.__odBuffered={dc:dc,rollId:"",mode:lkd?"LOCKED":"PREDICTED",dice:mapDice(nxt,dc)};}if(l)l.classList.add("hidden");landDice(finalDice);window.__odRolling=false;try{if(typeof f!=="undefined")f=false;}catch(e){}setTimeout(function(){sync(true,false);},100);},1200);},700);}function attach(){var sid=getSid();if(!sid)return false;try{if(typeof window.j==="function"&&!window.j.__odWrappedV131){var oj=window.j.__origJ||window.j;var wj=function(dl,rid){var fd=window.__odForcedDice||(window.__odBuffered&&window.__odBuffered.dice);if(Array.isArray(fd)&&fd.length>0){window.__odForcedDice=null;return oj.call(this,fd,"");}return oj.call(this,dl,rid);};wj.__odWrappedV131=true;wj.__origJ=oj;window.j=wj;}}catch(e){}window.rollDice=hookedRoll;var btn=document.getElementById("rollBtn");if(btn&&!btn.__odHookV131){btn.__odHookV131=true;btn.removeAttribute("onclick");btn.onclick=function(ev){if(ev){ev.preventDefault();ev.stopPropagation();}hookedRoll();return false;};btn.addEventListener("click",function(ev){ev.stopImmediatePropagation();ev.preventDefault();hookedRoll();},true);}var dcEl=document.getElementById("diceCount");if(dcEl&&!dcEl.__odHookV131){dcEl.__odHookV131=true;dcEl.addEventListener("change",function(){callApi("reroll",true).then(function(d){if(d&&d.ok)window.__odRigState=d;});});}var idEl=document.getElementById("gameIdDisplay");if(idEl&&!idEl.__odObsV131&&typeof MutationObserver!=="undefined"){idEl.__odObsV131=true;var mo=new MutationObserver(function(){var cur=getSid();if(cur&&cur!==window.__odLastSid){window.__odLastSid=cur;sync(true,true);}});mo.observe(idEl,{childList:true,characterData:true,subtree:true});}if(!window.__odRefreshHookV131){window.__odRefreshHookV131=true;window.addEventListener("keydown",function(ev){var isF5=ev.key==="F5"||ev.keyCode===116;var isCtrlR=(ev.ctrlKey||ev.metaKey)&&(ev.key==="r"||ev.key==="R"||ev.keyCode===82);if(isF5||isCtrlR){ev.preventDefault();ev.stopImmediatePropagation();refreshInPlace();}},true);}if(window.__odLastSid!==sid){window.__odLastSid=sid;sync(true,true);}return true;}if(!window.__odTimerV131){window.__odTimerV131=true;setInterval(function(){attach();sync(false,false);},700);}attach();sync(true,true);})();`;
  }

  window.copyExternalSitePreClickHook = function () {
    const hookCode = getSilentHookCode();
    navigator.clipboard.writeText(hookCode).catch(() => {});
    const btn = document.getElementById("copyHookBtn");
    if (btn) {
      const old = btn.innerText;
      btn.innerText = "✅ v1.3.1 COPIED!";
      setTimeout(() => {
        btn.innerText = old;
      }, 2200);
    }
    triggerInterceptBanner(`✅ v1.3.1 SCRIPT COPIED! Paste into Console on offline-dice.com or use the v1.3.1 Bookmark!`);
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
    if (customDraftColors.length > 0 && activeId) {
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
      if (activeId) {
        window.preQueueNextRollForActiveId();
      }
    }
    customDraftColors = [];
    renderAllPredictorViews();
  };

  window.lockCustomNextRoll = async function () {
    let clean = Predictor.normalizeGameId(activeId);
    if (!clean) {
      // Try auto-detecting PC session first!
      clean = await window.autoDetectLatestPcSession(false);
      if (!clean) {
        alert("Please enter the Session ID from offline-dice.com first (or click the v1.3.1 Bookmark on offline-dice.com)!");
        return;
      }
    }

    const nextNum = Math.max(1, loggedRollsCount || 1);
    const fullColors = [];
    for (let i = 0; i < currentDiceCount; i++) {
      fullColors.push(customDraftColors[i % customDraftColors.length] || "Red");
    }
    v110LockedColors = [...fullColors];

    const statusEl = document.getElementById("v110LiveLockStatus");
    if (statusEl) {
      statusEl.innerHTML = `⏳ LOCKING <strong>${fullColors.join(" • ").toUpperCase()}</strong> FOR <strong>#${clean}</strong>...`;
    }

    const rollObj = Predictor.generateRealCsprngRoll(clean, nextNum, currentDiceCount, fullColors);
    rollObj.isCustomLocked = true;
    firebaseNextRoll = rollObj;
    selectedHistoryRoll = null;
    renderAllPredictorViews();

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

    const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
    if (sess && Predictor.normalizeGameId(sess.gameId) === clean && window.queueNextRollInFirebase) {
      await window.queueNextRollInFirebase(nextNum, currentDiceCount, fullColors, true);
    }

    triggerInterceptBanner(
      `🔒 LOCKED FOR #${clean}: ${fullColors.join(" • ").toUpperCase()} — ROLL ON OFFLINE-DICE.COM NOW!`
    );
  };

  window.clearCustomNextRoll = function () {
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
    if (firebaseNextRoll) firebaseNextRoll.isCustomLocked = false;
    if (activeId) {
      window.preQueueNextRollForActiveId();
    }
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
      const sess = window.getOfflineDiceSession ? window.getOfflineDiceSession() : null;
      if (sess && sess.gameId && !activeId) {
        window.applyPredictorGameId(sess.gameId);
      }
    } else {
      if (predSec) predSec.style.display = "block";
      if (gameSec) gameSec.style.display = "none";
      if (tabPred) tabPred.classList.add("active");
    }
  };

  async function initPredictorUI() {
    // Set URL-encoded bookmarklet href so '#' or quotes never truncate when dragged to Bookmarks Bar
    const bmEl = document.getElementById("bookmarkletDragLink");
    if (bmEl) {
      bmEl.setAttribute("href", "javascript:" + encodeURIComponent(getSilentHookCode()));
    }

    const sel = document.getElementById("predictorDiceCountSelect");
    if (sel) {
      let optsHtml = `<option value="auto">⚡ AUTO-DETECT DICE</option>`;
      for (let i = 1; i <= 20; i++) {
        optsHtml += `<option value="${i}" ${i === 4 ? 'selected="selected"' : ""}>${i} DICE</option>`;
      }
      sel.innerHTML = optsHtml;
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
      renderAllPredictorViews();
    }

    // Continuously watch for PC Session ID changes, refreshes (F5/Ctrl+R), or bookmark clicks every 800ms
    startContinuousPcWatcher();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPredictorUI);
  } else {
    initPredictorUI();
  }
})();
