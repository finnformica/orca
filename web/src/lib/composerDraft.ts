// Persists an in-progress chat composer (text + image attachments + secret chips) to localStorage so a page
// reload never loses what you were typing. Images are stored as data URLs and rehydrated into
// File objects on load. Used by ChatComposer via its `persistKey` prop — one place, every box.
// `secrets`: the references of the secret chips (`chat/<name>`), never a value.
export type StoredDraft = { text: string; images: { name: string; type: string; dataUrl: string }[]; secrets: string[] };

const empty: StoredDraft = { text: "", images: [], secrets: [] };

export function loadDraft(key: string): StoredDraft {
  try { return { ...empty, ...JSON.parse(localStorage.getItem(key) ?? "{}") }; } catch { return empty; }
}

export function hasDraft(key: string): boolean {
  const d = loadDraft(key);
  return Boolean(d.text.trim() || d.images.length || d.secrets.length);
}

export function clearDraft(key: string) {
  localStorage.removeItem(key);
}

export async function saveDraft(key: string, text: string, images: File[], secrets: string[] = []) {
  if (!text.trim() && !images.length && !secrets.length) return clearDraft(key);
  // One attachment that fails to encode (a FileReader error) must not drop the whole draft, or
  // leave the composer's save chain rejected — which would stop every later save too. Keep the
  // text and whatever attachments did encode, the same fallback as the quota case below.
  const encoded = await Promise.allSettled(images.map(toStored));
  const stored: StoredDraft = { text, images: encoded.filter((r) => r.status === "fulfilled").map((r) => r.value), secrets };
  // Attachments can blow the ~5MB quota; if so, keep at least the text so it isn't lost.
  try { localStorage.setItem(key, JSON.stringify(stored)); }
  catch { try { localStorage.setItem(key, JSON.stringify({ text, images: [], secrets })); } catch { /* full */ } }
}

export async function draftFiles(key: string): Promise<File[]> {
  return Promise.all(loadDraft(key).images.map(toFile));
}

const toStored = (f: File) =>
  new Promise<StoredDraft["images"][number]>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, type: f.type, dataUrl: r.result as string });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

const toFile = async (img: StoredDraft["images"][number]) =>
  new File([await (await fetch(img.dataUrl)).blob()], img.name, { type: img.type });
