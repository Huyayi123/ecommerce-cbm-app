// Flush blur saves before the existing purchase submission starts.
const saves = new Map<string, Promise<unknown>>();
export function trackAlibabaDraft(id: string, save: Promise<unknown>) {
  saves.set(id,save);
  void save.then(()=>{if(saves.get(id)===save)saves.delete(id);},()=>{/* Retain failure until corrected. */});
}
export async function flushAlibabaDrafts(ids: string[]) {
  await Promise.all(ids.flatMap(id=>saves.has(id)?[saves.get(id)!]:[]));
}
