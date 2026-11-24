// ==UserScript==
// @name         Offline-Dice.com Silent Auto-Sync & Mobile Remote Control
// @namespace    https://offlinedicerdd.vercel.app/
// @version      1.1.0
// @description  Silently syncs offline-dice.com with offlinedicerdd.vercel.app (Option 1: Predict Before Roll + Option 2: Choose Color First from Mobile)
// @author       OfflineDicePredictor
// @match        *://*.offline-dice.com/*
// @match        *://offline-dice.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const silentHookCode = `
    (function initSilentOfflineDiceSyncV110() {
      const oldBar = document.getElementById("odHookPreviewBar");
      if (oldBar) oldBar.remove();
      if (window.__odPreClickActiveV110) return;

      const checkReady = setInterval(function () {
        try {
          if (typeof y !== "string" || !y || typeof rollDice !== "function" || typeof j !== "function" || typeof u === "undefined") {
            return;
          }
          clearInterval(checkReady);
          if (window.__odPreClickActiveV110) return;
          window.__odPreClickActiveV110 = true;
          window.__odPreClickActive = true;
          window.__odBuffered = null;
          window.__odLastLandedId = null;
          window.__odPrefetching = false;
          window.__odInitDone = false;

          const db = typeof n !== "undefined"
            ? n
            : firebase.database(firebase.apps[0], "https://offline-dice-verify-default-rtdb.europe-west1.firebasedatabase.app");

          function parseDiceFromVal(v) {
            const raw = Array.isArray(v.names) && v.names.length > 0 ? v.names : (Array.isArray(v.colors) ? v.colors : []);
            return raw.map(function (nm) {
              const s = String(nm || "").toUpperCase();
              return u.find(function (c) {
                return c.name.toUpperCase() === s || c.hex.toUpperCase() === s;
              }) || u[0];
            });
          }

          db.ref("sessions/" + y + "/rolls").on("value", function (snap) {
            if (f) return;
            const all = [];
            if (snap.exists()) {
              snap.forEach(function (ch) {
                all.push({ key: ch.key, val: ch.val() || {} });
              });
            }
            if (!window.__odInitDone) {
              window.__odInitDone = true;
              if (m > 0 && all.length > 0 && all.length <= m) {
                window.__odLastLandedId = all[all.length - 1].key;
              }
            }
            if (all.length > 0) {
              const latest = all[all.length - 1];
              const dice = parseDiceFromVal(latest.val);
              if (dice.length > 0 && latest.key !== window.__odLastLandedId) {
                window.__odBuffered = {
                  dc: dice.length,
                  rollId: latest.key,
                  dice: dice
                };
                return;
              }
            }
            if (!window.__odPrefetching) {
              window.__odPrefetch(true);
            }
          });

          window.__odPrefetch = async function (forceNew) {
            if (window.__odPrefetching) return;
            window.__odPrefetching = true;
            try {
              const dcEl = document.getElementById("diceCount");
              const dc = dcEl ? parseInt(dcEl.value, 10) || 4 : 4;
              if (!forceNew) {
                const snap = await db.ref("sessions/" + y + "/rolls").once("value");
                const all = [];
                if (snap.exists()) {
                  snap.forEach(function (ch) {
                    all.push({ key: ch.key, val: ch.val() || {} });
                  });
                }
                if (all.length > 0) {
                  const latest = all[all.length - 1];
                  const dice = parseDiceFromVal(latest.val);
                  if (dice.length > 0 && latest.key !== window.__odLastLandedId) {
                    window.__odBuffered = {
                      dc: dice.length,
                      rollId: latest.key,
                      dice: dice
                    };
                    return;
                  }
                }
              }
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
            } catch (e) {
            } finally {
              window.__odPrefetching = false;
            }
          };

          const dcSelect = document.getElementById("diceCount");
          if (dcSelect) {
            dcSelect.addEventListener("change", function () {
              window.__odPrefetch(true);
            });
          }

          window.rollDice = async function () {
            if (f) return;
            f = true;
            const dcEl = document.getElementById("diceCount");
            const dc = dcEl ? parseInt(dcEl.value, 10) || 4 : 4;
            if (!window.__odBuffered || !Array.isArray(window.__odBuffered.dice) || window.__odBuffered.dice.length === 0) {
              await window.__odPrefetch(true);
            }
            const cur = window.__odBuffered;
            const finalDice = Array.from({ length: dc }, function (_, idx) {
              return cur.dice[idx % cur.dice.length];
            });
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
                j(finalDice, cur.rollId);
                f = false;
                setTimeout(function () {
                  window.__odPrefetch(true);
                }, 80);
              }, 1200);
            }, 700);
          };
        } catch (err) {}
      }, 150);
    })();
  `;

  const scriptEl = document.createElement("script");
  scriptEl.textContent = silentHookCode;
  (document.head || document.documentElement).appendChild(scriptEl);
  scriptEl.remove();
})();
