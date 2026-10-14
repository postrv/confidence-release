/** Settle the retained command even after navigation, but never act on an old view. */
export async function observeCommand(request: () => Promise<boolean>, observer: {
  current: () => boolean;
  acknowledged: () => void;
  failed: (error: unknown) => void;
  finished: () => void;
}): Promise<boolean> {
  try {
    const confirmed = await request();
    if (!observer.current()) return false;
    if (confirmed) observer.acknowledged();
    return confirmed;
  } catch (error) {
    if (observer.current()) observer.failed(error);
    return false;
  } finally {
    if (observer.current()) observer.finished();
  }
}
