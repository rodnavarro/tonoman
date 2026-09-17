// One roster reconcile at a time, and never a lost request.
//
// A poke that arrives while a reload is running used to be DROPPED, on the theory that the running
// reload would see the write anyway. It does not when the write lands after that reload has already
// fetched the roster: the change then waited for the next timer tick, 30 seconds later. A schedule
// switch flipped twice in quick succession proved it — the second flip reached Temporal half a minute
// late. So a poke during a reload now asks for ONE more reload after it, however many pokes arrive.

/** Returns a trigger that runs `reload` serially and coalesces requests made while it runs into a
 *  single trailing run. `onError` sees a failed reload; the next request still runs. */
export function serialReload(reload: () => Promise<void>, onError: (e: unknown) => void): () => void {
  let busy = false;
  let again = false;
  const trigger = (): void => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    again = false;
    void reload()
      .catch(onError)
      .finally(() => {
        busy = false;
        if (again) trigger();
      });
  };
  return trigger;
}
