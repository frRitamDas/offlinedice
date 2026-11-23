// ==UserScript==
// @name         Offline-Dice.com Silent Auto-Sync
// @namespace    https://offlinedicerdd.vercel.app/
// @version      2.1.0
// @description  Silently syncs offline-dice.com upcoming rolls to Firebase before clicking Roll Again (Zero UI on offline-dice.com)
// @author       OfflineDicePredictor
// @match        *://*.offline-dice.com/*
// @match        *://offline-dice.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const silentHookCode = `
    (function initSilentOfflineDiceSync() {
      if (window.__odPreClickActive) return;
      const checkReady = setInterval(function () {
        try {
          if (typeof y !== "string" || !y || typeof rollDice !== "function" || typeof j !== "function" || typeof u === "undefined") {
            return;
          }
          clearInterval(checkReady);
          if (window.__odPreClickActive) return;
          window.__odPreClickActive = true;
          window.__odBuffered = null;
          window.__odLastLandedId = null;

          const db = typeof n !== "undefined"
            ? n
            : firebase.database(firebase.apps[0], "https://offline-dice-verify-default-rtdb.europe-west1.firebasedatabase.app");

          const existingBar = document.getElementById("odHookPreviewBar");
          if (existingBar) existingBar.remove();

          db.ref("sessions/" + y + "/rolls").limitToLast(1).on("value", function (snap) {
            if (!snap.exists() || f) return;
            snap.forEach(function (ch) {
              const k = ch.key;
              const v = ch.val() || {};
              if (k && k !== window.__odLastLandedId && Array.isArray(v.names) && v.names.length > 0) {
                window.__odBuffered = {
                  dc: v.names.length,
                  rollId: k,
                  dice: v.names.map(function (nm) {
                    return u.find(function (c) { return c.name === nm; }) || u[0];
                  })
                };
              }
            });
          });

          window.__odPrefetch = async function () {
            const dcEl = document.getElementById("diceCount");
            const dc = dcEl ? parseInt(dcEl.value, 10) || 4 : 4;
            try {
              const res = await a({ sessionId: y, diceCount: dc });
              const cols = (res && res.data && res.data.colors) || [];
              const rId = (res && res.data && res.data.rollId) || "";
              if (cols.length > 0) {
                window.__odBuffered = {
                  dc: dc,
                  rollId: rId,
                  dice: cols.map(function (nm) {
                    return u.find(function (c) { return c.name === nm; }) || u[0];
                  })
                };
                return;
              }
            } catch (e) {}
            const cols = Array.from({ length: dc }, function () { return u[x(u.length)]; });
            const ref = db.ref("sessions/" + y + "/rolls").push();
            await ref.set({
              colors: cols.map(function (c) { return c.hex; }),
              names: cols.map(function (c) { return c.name; }),
              time: Date.now(),
              isRigged: false,
              hash: "0x" + Array.from(crypto.getRandomValues(new Uint8Array(4))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("").toUpperCase()
            });
            window.__odBuffered = { dc: dc, rollId: ref.key, dice: cols };
          };

          const dcSelect = document.getElementById("diceCount");
          if (dcSelect) {
            dcSelect.addEventListener("change", function () {
              window.__odPrefetch();
            });
          }

          window.rollDice = async function () {
            if (f) return;
            f = true;
            const dcEl = document.getElementById("diceCount");
            const dc = dcEl ? parseInt(dcEl.value, 10) || 4 : 4;
            if (!window.__odBuffered || window.__odBuffered.dc !== dc) {
              await window.__odPrefetch();
            }
            const cur = window.__odBuffered;
            window.__odLastLandedId = cur.rollId;
            window.__odBuffered = null;

            const l = document.getElementById("rollOverlay");
            const i = document.getElementById("overlayTitle");
            const c = document.getElementById("overlayDiceContainer");
            const d = ["You're Cooked...", "Good Luck :)", "Amazing!", "Let's See...", "Offline Dice On TOP!", "Rolling..."];
            if (i) i.innerText = d[x(d.length)];
            if (c) {
              c.innerHTML = "";
              for (let k = 0; k < dc; k++) {
                const die = document.createElement("div");
                die.className = "big-die";
                const dot = document.createElement("div");
                dot.className = "big-die-dot";
                die.appendChild(dot);
                c.appendChild(die);
              }
            }
            setTimeout(function () {
              if (c) {
                c.querySelectorAll(".big-die").forEach(function (el) {
                  el.classList.add("initial-shake");
                });
              }
              if (l) l.classList.remove("hidden");
              s.currentTime = 0;
              s.play().catch(function () {});
              setTimeout(function () {
                if (l) l.classList.add("hidden");
                j(cur.dice, cur.rollId);
                f = false;
                window.__odPrefetch();
              }, 1200);
            }, 700);
          };

          window.__odPrefetch();
        } catch (err) {}
      }, 150);
    })();
  `;

  const scriptEl = document.createElement("script");
  scriptEl.textContent = silentHookCode;
  (document.head || document.documentElement).appendChild(scriptEl);
  scriptEl.remove();
})();
