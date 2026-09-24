// In-memory stand-in for a Netlify Blobs store (same method shapes).
export function memoryStore() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? structuredClone(m.get(key)) : null; },
    async setJSON(key, value) { m.set(key, structuredClone(value)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
