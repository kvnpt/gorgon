// Gorgon — one-handed gesture recogniser for the compose pad
// GPL-3.0
//
// Turns pointer input on one element into a small vocabulary:
//   tap, vertical drag in detent steps, horizontal swipe, long press.
// Vertical steps are reported live while the finger moves, relative to
// where the gesture started; the first step fires as soon as the drag is
// recognised, so even a short flick counts as one step.

const RECOGNISE_PX = 12;   // movement before a drag is recognised
const STEP_PX = 32;        // finger travel per extra step
const SWIPE_PX = 40;       // minimum horizontal travel for a swipe
const TAP_MS = 400;
const LONG_PRESS_MS = 500;

export function attachPad(el, handlers) {
  const h = {
    onTap() {}, onDragStart() {}, onStep() {}, onDragEnd() {},
    onSwipe() {}, onLongPress() {}, ...handlers,
  };
  let g = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), mode: null, steps: 0 };
    g.timer = setTimeout(() => {
      if (g && g.mode === null) {
        g.mode = 'long';
        h.onLongPress();
      }
    }, LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.mode === null) {
      if (Math.abs(dy) > RECOGNISE_PX && Math.abs(dy) >= Math.abs(dx)) {
        g.mode = 'vertical';
        clearTimeout(g.timer);
        h.onDragStart();
      } else if (Math.abs(dx) > RECOGNISE_PX && Math.abs(dx) > Math.abs(dy)) {
        g.mode = 'horizontal';
        clearTimeout(g.timer);
      }
    }
    if (g.mode === 'vertical') {
      const travel = Math.abs(dy);
      const n = travel <= RECOGNISE_PX ? 0 : 1 + Math.floor((travel - RECOGNISE_PX) / STEP_PX);
      const steps = dy < 0 ? n : -n;   // up = positive
      if (steps !== g.steps) {
        g.steps = steps;
        h.onStep(steps);
      }
    }
  });

  const finish = (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    const dx = e.clientX - g.x;
    const dt = performance.now() - g.t;
    if (g.mode === 'vertical') {
      h.onDragEnd(g.steps);
    } else if (!cancelled && g.mode === 'horizontal' && Math.abs(dx) >= SWIPE_PX) {
      h.onSwipe(dx > 0 ? 'right' : 'left');
    } else if (!cancelled && g.mode === null && dt < TAP_MS) {
      h.onTap();
    }
    g = null;
  };
  el.addEventListener('pointerup', (e) => finish(e, false));
  el.addEventListener('pointercancel', (e) => finish(e, true));
}
