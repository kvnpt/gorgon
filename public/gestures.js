// Gorgon — one-handed gesture recogniser for the compose pad
// GPL-3.0
//
// Turns pointer input on one element into a small vocabulary:
//   tap, vertical swipe (exactly one step per swipe), horizontal swipe,
//   long press.
// A vertical swipe fires once, as soon as it is recognised, so the pad
// responds under the thumb. Further travel in the same stroke does nothing:
// one swipe is always one increment, never a dial.

const RECOGNISE_PX = 18;   // movement before a swipe is recognised
const SWIPE_PX = 40;       // minimum horizontal travel for a sideways swipe
const TAP_MS = 400;
const LONG_PRESS_MS = 500;

export function attachPad(el, handlers) {
  const h = {
    onTap() {}, onVertical() {}, onSwipe() {}, onLongPress() {}, ...handlers,
  };
  let g = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), mode: null };
    g.timer = setTimeout(() => {
      if (g && g.mode === null) {
        g.mode = 'long';
        h.onLongPress();
      }
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id || g.mode !== null) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dy) > RECOGNISE_PX && Math.abs(dy) >= Math.abs(dx)) {
      g.mode = 'vertical';
      clearTimeout(g.timer);
      h.onVertical(dy < 0 ? 1 : -1);   // up = +1
    } else if (Math.abs(dx) > RECOGNISE_PX && Math.abs(dx) > Math.abs(dy)) {
      g.mode = 'horizontal';
      clearTimeout(g.timer);
    }
  });

  const finish = (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    const dx = e.clientX - g.x;
    const dt = performance.now() - g.t;
    if (!cancelled && g.mode === 'horizontal' && Math.abs(dx) >= SWIPE_PX) {
      h.onSwipe(dx > 0 ? 'right' : 'left');
    } else if (!cancelled && g.mode === null && dt < TAP_MS) {
      h.onTap();
    }
    g = null;
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
}
