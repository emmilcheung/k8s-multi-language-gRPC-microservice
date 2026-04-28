(function () {
  'use strict';

  var STEP = 0.15, MIN = 0.2, MAX = 6;
  var scale = 1, panX = 0, panY = 0;
  var dragging = false, lastX = 0, lastY = 0;
  var card = null, target = null;

  function clamp(v) { return Math.min(MAX, Math.max(MIN, v)); }

  function applyTransform() {
    target.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
    var lvl = document.getElementById('zoom-level');
    if (lvl) lvl.textContent = Math.round(scale * 100) + '%';
  }

  function zoomAt(delta, cx, cy) {
    var prev = scale;
    scale = clamp(scale + delta);
    panX = cx - (cx - panX) * (scale / prev);
    panY = cy - (cy - panY) * (scale / prev);
    applyTransform();
  }

  function resetView() {
    scale = 1; panX = 0; panY = 0;
    applyTransform();
  }

  function attachEvents() {
    // Wheel zoom — centered on cursor
    card.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r  = card.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? STEP : -STEP, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // Drag to pan
    card.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      card.style.cursor = 'grabbing';
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panX += e.clientX - lastX;
      panY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      applyTransform();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      card.style.cursor = 'grab';
    });

    // Buttons
    var zi = document.getElementById('zoom-in');
    var zo = document.getElementById('zoom-out');
    var zr = document.getElementById('zoom-reset');
    if (zi) zi.addEventListener('click', function () { zoomAt(STEP,  card.offsetWidth / 2, card.offsetHeight / 2); });
    if (zo) zo.addEventListener('click', function () { zoomAt(-STEP, card.offsetWidth / 2, card.offsetHeight / 2); });
    if (zr) zr.addEventListener('click', resetView);

    // Keyboard
    document.addEventListener('keydown', function (e) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(STEP,  card.offsetWidth / 2, card.offsetHeight / 2); }
      if (e.key === '-')                  { e.preventDefault(); zoomAt(-STEP, card.offsetWidth / 2, card.offsetHeight / 2); }
      if (e.key === '0')                  { e.preventDefault(); resetView(); }
    });
  }

  function attachZoom(el) {
    target = el;
    target.style.transformOrigin = '0 0';
    target.style.display         = 'block';
    applyTransform();
    attachEvents();
  }

  // Poll until diagram element is rendered and has dimensions
  var attempts = 0;
  var poll = setInterval(function () {
    if (++attempts > 80) { clearInterval(poll); return; }
    card = document.querySelector('.diagram-card');
    if (!card) return;
    var el = card.querySelector('svg') || card.querySelector('img');
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.width && r.height) { clearInterval(poll); attachZoom(el); }
  }, 100);

}());
