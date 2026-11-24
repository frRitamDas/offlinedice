// ==UserScript==
// @name         Offline-Dice.com Silent Auto-Sync & Mobile Remote Control
// @namespace    https://offlinedicerdd.vercel.app/
// @version      1.2.0
// @description  Connects offline-dice.com to https://offlinedicerdd.vercel.app/api/rig so locked & predicted dice colors sync 100% accurately
// @author       OfflineDicePredictor
// @match        *://*.offline-dice.com/*
// @match        *://offline-dice.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const silentHookCode = `
    (function initSilentOfflineDiceApiRigV120() {
      const oldBar = document.getElementById("odHookPreviewBar");
      if (oldBar) oldBar.remove();
      if (window.__odApiRigActiveV120) return;
      window.__odApiRigActiveV120 = true;
      window.__odPreClickActiveV110 = true;
      window.__odPreClickActive = true;

      const API_ENDPOINTS = [
        "https://offlinedicerdd.vercel.app/api/rig",
        "https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig"
      ];

      const DICE_PALETTE = [
        { name: "Red", hex: "#FF0000" },
        { name: "Orange", hex: "#FFA500" },
        { name: "Yellow", hex: "#FFD700" },
        { name: "Green", hex: "#008000" },
        { name: "Blue", hex: "#0000FF" },
        { name: "Purple", hex: "#800080" }
      ];

      window.__odRigState = null;
      window.__odBuffered = null;
      window.__odRolling = false;
      window.__odLastSessionId = "";

      function getSessionId() {
        const el = document.getElementById("gameIdDisplay");
        const domText = el ? String(el.innerText || el.textContent || "").trim() : "";
        if (domText && domText.toUpperCase() !== "LOADING...") {
          const cleaned = domText.toUpperCase().replace(/^#+/, "").replace(/[^A-Z0-9_-]/g, "");
          if (cleaned) return cleaned;
        }
        try {
          if (typeof y === "string" && y.trim()) {
            return y.trim().toUpperCase().replace(/^#+/, "").replace(/[^A-Z0-9_-]/g, "");
          }
        } catch (e) {}
        return "";
      }

      function getDiceCount() {
        const dcEl = document.getElementById("diceCount");
        return dcEl ? Math.min(100, Math.max(1, parseInt(dcEl.value, 10) || 4)) : 4;
      }

      function getPalette() {
        try {
          if (typeof u !== "undefined" && Array.isArray(u) && u.length === 6) return u;
        } catch (e) {}
        return DICE_PALETTE;
      }

      function mapNamesToDice(names, dc) {
        const palette = getPalette();
        const count = Math.min(100, Math.max(1, Number(dc) || 4));
        const src = Array.isArray(names) && names.length > 0 ? names : ["Red", "Orange", "Yellow", "Green"];
        const out = [];
        for (let i = 0; i < count; i++) {
          const raw = String(src[i % src.length] || "").toUpperCase();
          const match = palette.find(function (c) {
            return c.name.toUpperCase() === raw || c.hex.toUpperCase() === raw;
          }) || palette[0];
          out.push({ name: match.name, hex: match.hex });
        }
        return out;
      }

      function randomInt(max) {
        try {
          if (typeof x === "function") return x(max);
        } catch (e) {}
        const arr = new Uint32Array(1);
        window.crypto.getRandomValues(arr);
        return arr[0] % max;
      }

      async function callRigApi(payload) {
        const sid = payload.sessionId || getSessionId();
        if (!sid) return null;
        const reqBody = Object.assign(
          { sessionId: sid, diceCount: getDiceCount(), action: "status" },
          payload
        );
        for (let i = 0; i < API_ENDPOINTS.length; i++) {
          try {
            const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 2500) : null;
            const url =
              API_ENDPOINTS[i] +
              "?sessionId=" + encodeURIComponent(sid) +
              "&action=" + encodeURIComponent(reqBody.action) +
              "&diceCount=" + encodeURIComponent(reqBody.diceCount) +
              "&_t=" + Date.now();
            const resp = await fetch(url, {
              method: "POST",
              mode: "cors",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(reqBody),
              signal: ctrl ? ctrl.signal : undefined
            });
            if (timer) clearTimeout(timer);
            if (resp && resp.ok) {
              const data = await resp.json();
              if (data && data.ok) return data;
            }
          } catch (err) {}
        }
        return null;
      }

      async function syncRigStatus(force) {
        if (window.__odRolling && !force) return null;
        const sid = getSessionId();
        if (!sid) return null;
        const dc = getDiceCount();
        const data = await callRigApi({
          action: "status",
          sessionId: sid,
          diceCount: dc
        });
        if (data && data.ok) {
          window.__odRigState = data;
          const activeNames = Array.isArray(data.activeNames) && data.activeNames.length > 0
            ? data.activeNames
            : ["Red", "Orange", "Yellow", "Green"];
          window.__odBuffered = {
            dc: dc,
            rollId: "",
            mode: data.mode || "PREDICTED",
            dice: mapNamesToDice(activeNames, dc)
          };
        }
        return data;
      }

      function renderDiceFallback(finalDice) {
        try {
          if (typeof W === "function") W();
        } catch (e) {}
        const container = document.getElementById("diceContainer");
        if (!container) return;
        const frag = document.createDocumentFragment();
        finalDice.forEach(function (dieObj) {
          const wrap = document.createElement("div");
          wrap.className = "die-wrapper";
          const dieEl = document.createElement("div");
          dieEl.className = "die";
          dieEl.style.setProperty("background-color", dieObj.hex, "important");
          const dotEl = document.createElement("div");
          dotEl.className = "die-dot";
          const labelEl = document.createElement("div");
          labelEl.className = "die-label";
          labelEl.innerText = dieObj.name;
          labelEl.style.setProperty("color", dieObj.hex, "important");
          dieEl.appendChild(dotEl);
          wrap.appendChild(dieEl);
          wrap.appendChild(labelEl);
          frag.appendChild(wrap);
        });
        container.innerHTML = "";
        container.appendChild(frag);
        try {
          if (typeof G === "function") G(finalDice);
        } catch (e) {}
        const rCountEl = document.getElementById("rollsTodayCount");
        if (rCountEl) {
          const curVal = parseInt(rCountEl.innerText, 10) || 0;
          rCountEl.innerText = String(curVal + 1);
        }
      }

      async function executeHookedRoll() {
        if (window.__odRolling) return;
        try {
          if (typeof f !== "undefined" && f) return;
        } catch (e) {}

        window.__odRolling = true;
        try {
          if (typeof f !== "undefined") f = true;
        } catch (e) {}

        const dc = getDiceCount();
        const sid = getSessionId();

        // Immediately request consume from https://offlinedicerdd.vercel.app/api/rig while the roll animation plays
        const consumePromise = callRigApi({
          action: "consume",
          sessionId: sid,
          diceCount: dc
        });

        const l = document.getElementById("rollOverlay");
        const i = document.getElementById("overlayTitle");
        const c = document.getElementById("overlayDiceContainer");
        const titles = [
          "You're Cooked...",
          "Good Luck :)",
          "Amazing!",
          "Let's See...",
          "Offline Dice On TOP!",
          "Rolling..."
        ];
        if (i) i.innerText = titles[randomInt(titles.length)];
        if (c) {
          c.innerHTML = "";
          const frag = document.createDocumentFragment();
          for (let k = 0; k < dc; k++) {
            const die = document.createElement("div");
            die.className = "big-die";
            const dot = document.createElement("div");
            dot.className = "big-die-dot";
            die.appendChild(dot);
            frag.appendChild(die);
          }
          c.appendChild(frag);
        }

        setTimeout(function () {
          if (c) {
            c.querySelectorAll(".big-die").forEach(function (el) {
              el.classList.add("initial-shake");
            });
          }
          if (l) l.classList.remove("hidden");
          try {
            if (typeof s !== "undefined" && s && typeof s.play === "function") {
              s.currentTime = 0;
              s.play().catch(function () {});
            }
          } catch (e) {}

          setTimeout(async function () {
            let consumeRes = null;
            try {
              consumeRes = await consumePromise;
            } catch (e) {}

            let namesToLand = null;
            if (consumeRes && Array.isArray(consumeRes.rollToLandNames) && consumeRes.rollToLandNames.length > 0) {
              namesToLand = consumeRes.rollToLandNames;
            } else if (window.__odRigState && Array.isArray(window.__odRigState.activeNames) && window.__odRigState.activeNames.length > 0) {
              namesToLand = window.__odRigState.activeNames;
            } else if (window.__odBuffered && Array.isArray(window.__odBuffered.dice) && window.__odBuffered.dice.length > 0) {
              namesToLand = window.__odBuffered.dice.map(function (d) { return d.name; });
            } else {
              const palette = getPalette();
              namesToLand = Array.from({ length: dc }, function () {
                return palette[randomInt(palette.length)].name;
              });
            }

            const finalDice = mapNamesToDice(namesToLand, dc);

            // Update cached state with the next roll returned by consume
            if (consumeRes && consumeRes.nextState) {
              const ns = consumeRes.nextState;
              const nextIsLocked = Boolean(ns.is_locked) && Array.isArray(ns.locked_names) && ns.locked_names.length > 0;
              const nextActiveNames = nextIsLocked ? ns.locked_names : (ns.predicted_names || []);
              window.__odRigState = {
                ok: true,
                sessionId: sid,
                mode: nextIsLocked ? "LOCKED" : "PREDICTED",
                activeNames: nextActiveNames,
                state: ns
              };
              window.__odBuffered = {
                dc: dc,
                rollId: "",
                mode: nextIsLocked ? "LOCKED" : "PREDICTED",
                dice: mapNamesToDice(nextActiveNames, dc)
              };
            } else {
              window.__odBuffered = null;
            }

            if (l) l.classList.add("hidden");

            try {
              if (typeof j === "function") {
                j(finalDice, "");
              } else {
                renderDiceFallback(finalDice);
              }
            } catch (err) {
              renderDiceFallback(finalDice);
            }

            window.__odRolling = false;
            try {
              if (typeof f !== "undefined") f = false;
            } catch (e) {}

            setTimeout(function () {
              syncRigStatus(true);
            }, 150);
          }, 1200);
        }, 700);
      }

      function attachHooks() {
        const sid = getSessionId();
        if (!sid) return false;

        window.rollDice = executeHookedRoll;

        const rollBtn = document.getElementById("rollBtn");
        if (rollBtn && !rollBtn.__odApiHookedV120) {
          rollBtn.__odApiHookedV120 = true;
          rollBtn.addEventListener(
            "click",
            function (ev) {
              ev.stopImmediatePropagation();
              ev.preventDefault();
              executeHookedRoll();
            },
            true
          );
        }

        const dcSelect = document.getElementById("diceCount");
        if (dcSelect && !dcSelect.__odApiHookedV120) {
          dcSelect.__odApiHookedV120 = true;
          dcSelect.addEventListener("change", function () {
            callRigApi({
              action: "reroll",
              sessionId: getSessionId(),
              diceCount: getDiceCount()
            }).then(function (data) {
              if (data && data.ok) {
                window.__odRigState = data;
              }
            });
          });
        }

        if (window.__odLastSessionId !== sid) {
          window.__odLastSessionId = sid;
          syncRigStatus(true);
        }
        return true;
      }

      const initTimer = setInterval(function () {
        if (attachHooks()) {
          clearInterval(initTimer);
        }
      }, 150);

      // Keep polling https://offlinedicerdd.vercel.app/api/rig every 1s so mobile color locks arrive immediately
      setInterval(function () {
        attachHooks();
        syncRigStatus(false);
      }, 1000);
    })();
  `;

  const scriptEl = document.createElement("script");
  scriptEl.textContent = silentHookCode;
  (document.head || document.documentElement).appendChild(scriptEl);
  scriptEl.remove();
})();
