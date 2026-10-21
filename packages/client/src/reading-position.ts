const timeline = document.querySelector(".timeline") as HTMLElement;
const thread = timeline.querySelector(".thread") as HTMLElement;
const latest = document.getElementById("back-to-latest") as HTMLButtonElement;
interface Position {
  follow: boolean;
  top: number;
  anchor?: string;
  offset: number;
}
const positions = new Map<string, Position>();
let selected: string | undefined;
let restoring = false;
let restoredTop = 0;
let layout = "";
const geometry = () => `${timeline.clientWidth}:${timeline.clientHeight}:${timeline.scrollHeight}`;
let frame = 0;
function position(): Position | undefined {
  return selected ? positions.get(selected) : undefined;
}
function capture(state: Position): void {
  state.top = timeline.scrollTop;
  const top = timeline.getBoundingClientRect().top;
  const anchor = [...thread.querySelectorAll<HTMLElement>("article[data-message-id]")].find(
    (item) => item.getBoundingClientRect().bottom > top,
  );
  state.anchor = anchor?.dataset.messageId;
  state.offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
}
export function restoreReadingPosition(): void {
  const state = position();
  if (!state || !timeline.clientHeight) return;
  restoring = true;
  if (state.follow) timeline.scrollTop = timeline.scrollHeight;
  else {
    const anchor = [...thread.querySelectorAll<HTMLElement>("article[data-message-id]")].find(
      (item) => item.dataset.messageId === state.anchor,
    );
    timeline.scrollTop = anchor
      ? timeline.scrollTop +
        anchor.getBoundingClientRect().top -
        timeline.getBoundingClientRect().top -
        state.offset
      : state.top;
  }
  restoredTop = timeline.scrollTop;
  layout = geometry();
  latest.hidden = state.follow;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    restoring = false;
  });
}
export function selectReadingBot(botId: string | undefined): void {
  selected = botId;
  if (botId && !positions.has(botId)) positions.set(botId, { follow: true, top: 0, offset: 0 });
}
timeline.addEventListener("scroll", () => {
  const state = position();
  const clampedTop = Math.min(
    restoredTop,
    Math.max(0, timeline.scrollHeight - timeline.clientHeight),
  );
  if (state && layout !== geometry() && Math.abs(timeline.scrollTop - clampedTop) < 1) {
    restoreReadingPosition();
    return;
  }
  if (!state || (restoring && Math.abs(timeline.scrollTop - restoredTop) < 1)) return;
  // Reflow can clamp the viewport to zero without the reader choosing to follow.
  if (timeline.scrollHeight <= timeline.clientHeight) return;
  state.follow = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
  capture(state);
  layout = geometry();
  latest.hidden = state.follow;
});
latest.addEventListener("click", () => {
  const state = position();
  if (state) state.follow = true;
  document.dispatchEvent(new Event("history-latest"));
  restoreReadingPosition();
});
new ResizeObserver(restoreReadingPosition).observe(timeline);
new ResizeObserver(restoreReadingPosition).observe(thread);
