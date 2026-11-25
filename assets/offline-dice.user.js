// ==UserScript==
// @name         Offline-Dice.com Silent Auto-Sync & Mobile Remote Control (v1.4.0)
// @namespace    https://offlinedicerdd.vercel.app/
// @version      1.4.0
// @description  Automatically runs on every refresh of offline-dice.com and silently syncs Session ID & locked dice colors with https://offlinedicerdd.vercel.app/api/rig (v1.4.0)
// @author       OfflineDicePredictor
// @match        *://*.offline-dice.com/*
// @match        *://offline-dice.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const silentHookCode = `
    (function odMainV140() {
      window.__odV140Active = true;
      const oldBar = document.getElementById("odHookPreviewBar");
      if (oldBar) oldBar.remove();
      const st = document.getElementById("successToast");
      if (st) st.classList.remove("show");

      const API_ENDPOINTS = [
        "https://iejditssxoknjpkfahxs.supabase.co/functions/v1/rig",
        "https://offlinedicerdd.vercel.app/api/rig"
      ];

      const DICE_PALETTE = [
        { name: "Red", hex: "\\x23FF0000" },
        { name: "Orange", hex: "\\x23FFA500" },
        { name: "Yellow", hex: "\\x23FFD700" },
        { name: "Green", hex: "\\x23008000" },
        { name: "Blue", hex: "\\x230000FF" },
        { name: "Purple", hex: "\\x23800080" }
      ];

      window.__odRigState = window.__odRigState || null;
      window.__odBuffered = window.__odBuffered || null;
      window.__odForcedDice = null;
      window.__odRolling = false;
      window.__odLastSessionId = window.__odLastSessionId || "";

      function stripHashPrefix(str) {
        return String(str || "").trim().toUpperCase().replace(new RegExp("^\\x23+"), "").replace(/[^A-Z0-9_-]/g, "");
      }

      function generateFreshSessionId() {
        try {
          if (typeof R === "function") return stripHashPrefix(R());
        } catch (e) {}
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let out = "";
        for (let i = 0; i < 10; i++) {
          const arr = new Uint32Array(1);
          window.crypto.getRandomValues(arr);
          out += chars[arr[0] % 36];
        }
        return out;
      }

      function getSessionId() {
        const el = document.getElementById("gameIdDisplay");
        const domText = el ? String(el.innerText || el.textContent || "").trim() : "";
        if (domText && domText.toUpperCase() !== "LOADING...") {
          const cleaned = stripHashPrefix(domText);
          if (cleaned) return cleaned;
        }
        try {
          if (typeof y === "string" && y.trim()) {
            return stripHashPrefix(y);
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
          const raw = String(src[i % src.length] || "").trim().toUpperCase();
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

      async function callRigApiGet(action, extraParams) {
        const sid = (extraParams && extraParams.sessionId) || getSessionId();
        if (!sid) return null;
        const dc = (extraParams && extraParams.diceCount) || getDiceCount();
        const ping = extraParams && extraParams.pingEvent ? "&pingEvent=1" : "";
        const qs =
          "?action=" + encodeURIComponent(action || "status") +
          "&sessionId=" + encodeURIComponent(sid) +
          "&diceCount=" + encodeURIComponent(dc) +
          "&source=pc" +
          ping +
          "&_t=" + Date.now();

        for (let i = 0; i < API_ENDPOINTS.length; i++) {
          try {
            const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
            const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 2500) : null;
            const resp = await fetch(API_ENDPOINTS[i] + qs, {
              method: "GET",
              mode: "cors",
              cache: "no-store",
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

      async function syncRigStatus(force, isPingEvent) {
        if (window.__odRolling && !force) return null;
        const sid = getSessionId();
        if (!sid) return null;
        const dc = getDiceCount();
        const data = await callRigApiGet("status", {
          sessionId: sid,
          diceCount: dc,
          pingEvent: Boolean(isPingEvent)
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
      }

      function performSeamlessSessionRefresh() {
        if (window.__odRolling) return;
        const newSid = generateFreshSessionId();
        document.body.style.transition = "opacity 0.1s ease";
        document.body.style.opacity = "0.4";
        setTimeout(function () {
          document.body.style.opacity = "1";
        }, 120);

        try {
          if (typeof y !== "undefined") y = newSid;
          if (typeof m !== "undefined") m = 0;
          if (typeof p !== "undefined" && Array.isArray(p)) p.length = 0;
          if (typeof V === "function") V();
        } catch (e) {}

        const idEl = document.getElementById("gameIdDisplay");
        if (idEl) idEl.innerText = newSid;

        const rCountEl = document.getElementById("rollsTodayCount");
        if (rCountEl) rCountEl.innerText = "0";

        const histEl = document.getElementById("inlineHistoryList");
        if (histEl) {
          histEl.innerHTML = '<div style="color: \\x23aaa; text-align: center; font-weight: 500; padding: 10px;">Roll the dice to see your history!</div>';
        }

        const dc = getDiceCount();
        const defaultDice = mapNamesToDice(["Red", "Orange", "Yellow", "Green"], dc);
        renderDiceFallback(defaultDice);

        try {
          if (typeof updateVerifyLink === "function") updateVerifyLink();
        } catch (e) {}

        try {
          if (typeof n !== "undefined" && n && typeof n.ref === "function") {
            n.ref("sessions/" + newSid + "/status").set("active").catch(function () {});
          }
        } catch (e) {}

        window.__odLastSessionId = newSid;
        syncRigStatus(true, true);
      }

      function applyLandedDiceToScreen(finalDice) {
        window.__odForcedDice = finalDice;
        let calledJ = false;
        try {
          if (typeof window.j === "function") {
            const targetJ = window.j.__origJ || window.j;
            targetJ(finalDice, "");
            calledJ = true;
          } else if (typeof j === "function") {
            j(finalDice, "");
            calledJ = true;
          }
        } catch (e) {}

        if (!calledJ) {
          renderDiceFallback(finalDice);
          const rCountEl = document.getElementById("rollsTodayCount");
          if (rCountEl) {
            const curVal = parseInt(rCountEl.innerText, 10) || 0;
            rCountEl.innerText = String(curVal + 1);
          }
        }

        setTimeout(function () {
          const container = document.getElementById("diceContainer");
          if (!container) return;
          const labels = container.querySelectorAll(".die-label");
          let mismatch = labels.length !== finalDice.length;
          if (!mismatch) {
            labels.forEach(function (el, idx) {
              if (String(el.textContent || "").trim().toUpperCase() !== finalDice[idx].name.toUpperCase()) {
                mismatch = true;
              }
            });
          }
          if (mismatch) {
            renderDiceFallback(finalDice);
          }
        }, 40);
      }

      async function executeHookedRoll() {
        if (window.__odRolling) return;
        window.__odRolling = true;
        try {
          if (typeof f !== "undefined") f = true;
        } catch (e) {}

        const dc = getDiceCount();
        const sid = getSessionId();

        const cachedNames =
          window.__odRigState && Array.isArray(window.__odRigState.activeNames) && window.__odRigState.activeNames.length > 0
            ? window.__odRigState.activeNames.slice()
            : null;

        const consumePromise = callRigApiGet("consume", {
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
            } else if (cachedNames && cachedNames.length > 0) {
              namesToLand = cachedNames;
            } else if (window.__odBuffered && Array.isArray(window.__odBuffered.dice) && window.__odBuffered.dice.length > 0) {
              namesToLand = window.__odBuffered.dice.map(function (d) { return d.name; });
            } else {
              const palette = getPalette();
              namesToLand = Array.from({ length: dc }, function () {
                return palette[randomInt(palette.length)].name;
              });
            }

            const finalDice = mapNamesToDice(namesToLand, dc);

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
            }

            if (l) l.classList.add("hidden");

            applyLandedDiceToScreen(finalDice);

            window.__odRolling = false;
            try {
              if (typeof f !== "undefined") f = false;
            } catch (e) {}

            setTimeout(function () {
              syncRigStatus(true, false);
            }, 100);
          }, 1200);
        }, 700);
      }

      function attachHooks() {
        const sid = getSessionId();
        if (!sid) return false;

        try {
          if (typeof window.j === "function" && !window.j.__odWrappedV140) {
            const origJ = window.j.__origJ || window.j;
            const wrappedJ = function (diceList, rollId) {
              const forced = window.__odForcedDice || (window.__odBuffered && window.__odBuffered.dice);
              if (Array.isArray(forced) && forced.length > 0) {
                window.__odForcedDice = null;
                return origJ.call(this, forced, "");
              }
              return origJ.call(this, diceList, rollId);
            };
            wrappedJ.__odWrappedV140 = true;
            wrappedJ.__origJ = origJ;
            window.j = wrappedJ;
          }
        } catch (e) {}

        window.rollDice = executeHookedRoll;

        const rollBtn = document.getElementById("rollBtn");
        if (rollBtn && !rollBtn.__odApiHookedV140) {
          rollBtn.__odApiHookedV140 = true;
          rollBtn.removeAttribute("onclick");
          rollBtn.onclick = function (ev) {
            if (ev) {
              ev.preventDefault();
              ev.stopPropagation();
            }
            executeHookedRoll();
            return false;
          };
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
        if (dcSelect && !dcSelect.__odApiHookedV140) {
          dcSelect.__odApiHookedV140 = true;
          dcSelect.addEventListener("change", function () {
            callRigApiGet("reroll", {
              sessionId: getSessionId(),
              diceCount: getDiceCount(),
              pingEvent: true
            }).then(function (data) {
              if (data && data.ok) {
                window.__odRigState = data;
              }
            });
          });
        }

        const idEl = document.getElementById("gameIdDisplay");
        if (idEl && !idEl.__odObservedV140 && typeof MutationObserver !== "undefined") {
          idEl.__odObservedV140 = true;
          const obs = new MutationObserver(function () {
            const cur = getSessionId();
            if (cur && cur !== window.__odLastSessionId) {
              window.__odLastSessionId = cur;
              syncRigStatus(true, true);
            }
          });
          obs.observe(idEl, { childList: true, characterData: true, subtree: true });
        }

        if (window.__odLastSessionId !== sid) {
          window.__odLastSessionId = sid;
          syncRigStatus(true, true);
        }
        return true;
      }

      if (!window.__odIntervalStartedV140) {
        window.__odIntervalStartedV140 = true;
        setInterval(function () {
          attachHooks();
          syncRigStatus(false, false);
        }, 650);
      }

      attachHooks();
      syncRigStatus(true, true);
    })();
  `;

  const scriptEl = document.createElement("script");
  scriptEl.textContent = silentHookCode;
  (document.head || document.documentElement).appendChild(scriptEl);
  scriptEl.remove();
})();
