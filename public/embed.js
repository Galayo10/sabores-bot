(function(){
  const BOT_ORIGIN = (document.currentScript && document.currentScript.dataset.bot) || 'https://bot.casa-alonso.es';
  const START_OPEN = (document.currentScript && document.currentScript.dataset.open === 'true');

  // Styles
  const css = `
  .sg-widget-btn {
    position: fixed; right: 20px; bottom: 20px; z-index: 999999;
    background:#2a7c3f; color:#fff; border:2px solid #000; border-radius:999px;
    padding: 10px 14px; font-weight:700; cursor:pointer; box-shadow:0 6px 20px rgba(0,0,0,.2);
  }
  .sg-widget-btn:hover{ filter: brightness(1.05); }
  .sg-widget-frame {
    position: fixed; right: 20px; bottom: 80px; width: 380px; height: 560px; z-index: 999999;
    border-radius:14px; overflow:hidden; border:2px solid #000; box-shadow:0 12px 30px rgba(0,0,0,.25);
    background:#fff; display:none;
  }
  .sg-widget-frame.is-open { display:block; }
  .sg-widget-close {
    position: absolute; top: 8px; right: 8px; z-index: 2; background:#fff; border:1px solid #000;
    border-radius:999px; padding:4px 8px; font-size:12px; cursor:pointer;
  }
  @media (max-width: 520px){
    .sg-widget-frame { right:10px; bottom:70px; width: calc(100vw - 20px); height: 70vh; }
    .sg-widget-btn { right:10px; bottom:10px; }
  }`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Button
  const btn = document.createElement('button');
  btn.className = 'sg-widget-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label','Abrir asistente');
  btn.textContent = '💬 Ayuda';
  document.body.appendChild(btn);

  // Frame
  const frameWrap = document.createElement('div');
  frameWrap.className = 'sg-widget-frame';
  const close = document.createElement('button');
  close.className = 'sg-widget-close';
  close.textContent = '✕';
  const iframe = document.createElement('iframe');
  iframe.src = BOT_ORIGIN + '/embed';
  iframe.title = 'Asistente Sabores del Guijo';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';

  frameWrap.appendChild(close);
  frameWrap.appendChild(iframe);
  document.body.appendChild(frameWrap);

  function openWidget(){ frameWrap.classList.add('is-open'); }
  function closeWidget(){ frameWrap.classList.remove('is-open'); }

  btn.addEventListener('click', () => {
    if (frameWrap.classList.contains('is-open')) closeWidget(); else openWidget();
  });
  close.addEventListener('click', closeWidget);

  if (START_OPEN) openWidget();

  // (Opcional) permitir que el iframe pida resize vía postMessage
  window.addEventListener('message', (e) => {
    // seguridad básica
    if (!String(e.origin).startsWith(BOT_ORIGIN)) return;
    const { type, width, height } = e.data || {};
    if (type === 'sg-resize' && width && height) {
      frameWrap.style.width = width + 'px';
      frameWrap.style.height = height + 'px';
    }
  });
})();