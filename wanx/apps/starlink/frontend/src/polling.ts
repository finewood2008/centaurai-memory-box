type Activity = { foreground_count: number; sensitive_job: { status: string } | null };

export function taskPollDelay(activity: Activity | null): number {
  return !activity || activity.foreground_count > 0 ||
    ["queued", "running"].includes(activity.sensitive_job?.status ?? "") ? 1800 : 15000;
}

/** Schedule after completion, so slow requests never accumulate. */
export function startVisiblePolling(options: {
  refresh: () => Promise<unknown>;
  delay: () => number;
  onError: (error: unknown) => void;
  visibility?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  timers?: Pick<Window, "setTimeout" | "clearTimeout">;
}) {
  const visibility = options.visibility ?? document;
  const timers = options.timers ?? window;
  let timer: number | undefined;
  let stopped = false;
  let running = false;
  let resume = false;
  function clear() {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  }
  async function tick() {
    clear();
    if (stopped || visibility.hidden || running) return;
    running = true;
    let failed = false;
    try { await options.refresh(); }
    catch (error) { failed = true; if (!stopped) options.onError(error); }
    finally {
      running = false;
      if (!stopped && !visibility.hidden) {
        timer = timers.setTimeout(() => void tick(), resume ? 0 : failed ? 15000 : options.delay());
      }
      resume = false;
    }
  }
  function changed() {
    clear();
    if (!visibility.hidden) {
      if (running) resume = true;
      else void tick();
    }
  }
  visibility.addEventListener("visibilitychange", changed);
  void tick();
  return () => {
    stopped = true;
    clear();
    visibility.removeEventListener("visibilitychange", changed);
  };
}
