(function () {
  const script = document.currentScript;
  const BOT_ORIGIN = script.getAttribute("data-bot") || "https://sabores-bot.onrender.com";

  // CONTENEDOR
  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.bottom = "20px";
  wrapper.style.right = "20px";
  wrapper.style.zIndex = "9999";

  // BURBUJA TEXTO
  const bubble = document.createElement("div");
  bubble.innerText = "¿Necesitas ayuda?";
  bubble.style.background = "#fff";
  bubble.style.color = "#333";
  bubble.style.padding = "8px 12px";
  bubble.style.borderRadius = "20px";
  bubble.style.marginBottom = "8px";
  bubble.style.fontSize = "13px";
  bubble.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";
  bubble.style.fontFamily = "sans-serif";

  // BOTÓN (LOGO)
  const button = document.createElement("img");
  button.src = BOT_ORIGIN + "/logo-sabores.png"; // 👈 usa tu logo
  button.style.width = "60px";
  button.style.height = "60px";
  button.style.borderRadius = "50%";
  button.style.cursor = "pointer";
  button.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
  button.style.background = "#fff";
  button.style.objectFit = "cover";

  // CONTENEDOR CHAT
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.bottom = "90px";
  container.style.right = "20px";
  container.style.width = "350px";
  container.style.height = "500px";
  container.style.background = "#fff";
  container.style.borderRadius = "12px";
  container.style.boxShadow = "0 10px 30px rgba(0,0,0,0.3)";
  container.style.overflow = "hidden";
  container.style.display = "none";
  container.style.zIndex = "9999";

  // iframe
  const iframe = document.createElement("iframe");
  iframe.src = BOT_ORIGIN + "/embed";
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "none";

  container.appendChild(iframe);

  // abrir/cerrar
  let open = false;
  button.onclick = () => {
    open = !open;
    container.style.display = open ? "block" : "none";
    bubble.style.display = "none"; // ocultar mensaje al abrir
  };

  // montar
  wrapper.appendChild(bubble);
  wrapper.appendChild(button);
  document.body.appendChild(wrapper);
  document.body.appendChild(container);
})();