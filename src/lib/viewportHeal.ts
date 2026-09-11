// iOS standalone-PWA viewport heal.
//
// In "Add to Home Screen" mode, the first time the software keyboard opens the
// WebKit viewport shrinks (window.innerHeight / 100vh drop by the keyboard
// accessory height) and NEVER recovers when it closes — the app keeps a dead
// strip at the bottom until force-quit. No CSS unit or viewport meta fixes it;
// the only known cure is forcing WebKit to re-measure the canvas by toggling
// display on a full-viewport element after the keyboard is gone.
//
// Cheap and safe everywhere else: the height-delta check means it never fires
// on browsers/platforms that resize the viewport correctly.

export function installViewportHeal(): void {
  let maxVH = window.innerHeight;
  window.addEventListener("resize", () => {
    maxVH = Math.max(maxVH, window.innerHeight);
  });

  function heal(): void {
    if (maxVH - window.innerHeight <= 4) return;
    const app = document.querySelector<HTMLElement>(".app");
    if (!app) return;
    const scroller = document.querySelector<HTMLElement>(".app-main");
    const scrollTop = scroller?.scrollTop ?? 0;
    app.style.display = "none";
    void app.offsetHeight; // synchronous reflow — makes the toggle a real re-measure
    app.style.display = "";
    if (scroller) scroller.scrollTop = scrollTop;
  }

  // Keyboard dismissal = focus leaving an input; the ~140ms delay lets the
  // keyboard finish its close animation before we measure.
  document.addEventListener("focusout", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      setTimeout(heal, 140);
    }
  });
}
