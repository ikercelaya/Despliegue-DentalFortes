/* =====================================================================
 * Dental Fortes — Widget de chat embebible
 * Uso en la web de la clínica:
 *   <script src="https://TU-DOMINIO.vercel.app/widget.js"
 *           data-api="https://TU-DOMINIO.vercel.app" defer></script>
 * Si se sirve desde el mismo dominio, data-api es opcional.
 * ===================================================================== */
(function () {
  "use strict";
  var script = document.currentScript;
  var API = (script && script.getAttribute("data-api")) || "";
  API = API.replace(/\/$/, "");
  var TOKEN_KEY = "df_chat_token";

  // ---------- estilos ----------
  var css = `
  .dfw-bubble{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;
    background:linear-gradient(135deg,#3a3a3a,#1a1a1a);color:#f0f0f0;border:1px solid #4a4a4a;
    box-shadow:0 10px 30px rgba(0,0,0,.35);cursor:pointer;z-index:2147483000;display:flex;
    align-items:center;justify-content:center;transition:transform .18s;}
  .dfw-bubble:hover{transform:translateY(-2px) scale(1.04);}
  .dfw-bubble svg{width:26px;height:26px;}
  .dfw-panel{position:fixed;right:20px;bottom:92px;width:360px;max-width:calc(100vw - 40px);
    height:520px;max-height:calc(100vh - 120px);background:#1e1e1e;border:1px solid #3d3d3d;
    border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.55);z-index:2147483000;display:none;
    flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}
  .dfw-panel.dfw-open{display:flex;animation:dfwUp .22s ease;}
  @keyframes dfwUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
  .dfw-head{padding:14px 16px;background:linear-gradient(135deg,#2b2b2b,#232323);border-bottom:1px solid #3d3d3d;
    color:#f0f0f0;display:flex;align-items:center;justify-content:space-between;}
  .dfw-head strong{font-size:15px;font-weight:600;}
  .dfw-head span{display:block;font-size:12px;color:#8a8a8a;}
  .dfw-close{background:transparent;border:0;color:#b8b8b8;font-size:20px;cursor:pointer;line-height:1;}
  .dfw-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#1a1a1a;}
  .dfw-msg{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}
  .dfw-bot{align-self:flex-start;background:#2d2d2d;color:#f0f0f0;border:1px solid #3d3d3d;border-bottom-left-radius:4px;}
  .dfw-user{align-self:flex-end;background:linear-gradient(135deg,#d9d9d9,#9b9b9b);color:#1a1a1a;border-bottom-right-radius:4px;}
  .dfw-typing{align-self:flex-start;color:#8a8a8a;font-size:13px;font-style:italic;}
  .dfw-foot{padding:10px;border-top:1px solid #3d3d3d;background:#1e1e1e;display:flex;gap:8px;}
  .dfw-foot input{flex:1;background:#232323;border:1px solid #3d3d3d;color:#f0f0f0;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;}
  .dfw-foot input:focus{border-color:#c8c8c8;}
  .dfw-foot button{background:linear-gradient(135deg,#d9d9d9,#9b9b9b);color:#1a1a1a;border:0;border-radius:10px;padding:0 14px;font-weight:700;cursor:pointer;}
  .dfw-foot button:disabled{opacity:.5;cursor:not-allowed;}
  `;
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- DOM ----------
  var bubble = document.createElement("button");
  bubble.className = "dfw-bubble";
  bubble.setAttribute("aria-label", "Abrir chat");
  bubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  var panel = document.createElement("div");
  panel.className = "dfw-panel";
  panel.innerHTML =
    '<div class="dfw-head"><div><strong>Dental Fortes</strong><span>Asistente de la clínica</span></div>' +
    '<button class="dfw-close" aria-label="Cerrar">&times;</button></div>' +
    '<div class="dfw-msgs" id="dfwMsgs"></div>' +
    '<div class="dfw-foot"><input id="dfwInput" type="text" placeholder="Escriba su mensaje..." autocomplete="off" />' +
    '<button id="dfwSend">Enviar</button></div>';

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var msgs = panel.querySelector("#dfwMsgs");
  var input = panel.querySelector("#dfwInput");
  var sendBtn = panel.querySelector("#dfwSend");
  var greeted = false;

  function addMsg(text, who) {
    var el = document.createElement("div");
    el.className = "dfw-msg " + (who === "user" ? "dfw-user" : "dfw-bot");
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function openPanel() {
    panel.classList.add("dfw-open");
    if (!greeted) {
      greeted = true;
      addMsg("Hola, soy el asistente de Dental Fortes. Para atenderle mejor, ¿me indica su nombre completo, por favor?", "bot");
    }
    setTimeout(function () { input.focus(); }, 100);
  }
  function closePanel() { panel.classList.remove("dfw-open"); }

  bubble.addEventListener("click", function () {
    panel.classList.contains("dfw-open") ? closePanel() : openPanel();
  });
  panel.querySelector(".dfw-close").addEventListener("click", closePanel);

  async function send() {
    var text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    addMsg(text, "user");
    sendBtn.disabled = true;

    var typing = document.createElement("div");
    typing.className = "dfw-typing";
    typing.textContent = "escribiendo…";
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      var r = await fetch(API + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, token: localStorage.getItem(TOKEN_KEY) || null }),
      });
      var data = await r.json();
      typing.remove();
      if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
      addMsg(data.reply || "Disculpe, ha habido una incidencia. Inténtelo de nuevo.", "bot");
    } catch (_e) {
      typing.remove();
      addMsg("No se ha podido conectar. Inténtelo de nuevo en un momento.", "bot");
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); send(); }
  });
})();
