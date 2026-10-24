// Shared HTTP helpers for the data pipeline scripts.
// Polite fetching: descriptive User-Agent (Wikimedia policy), bounded concurrency,
// minimum interval between request starts, retries with Retry-After support.

export const USER_AGENT =
  'books-in-order-tools/1.0 (https://kolejnoscksiazek.pl)';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch a URL and parse the response as JSON.
// Returns { status, data } — data is null for 404 (treated as "not found", not an error).
// Throws after repeated 429/5xx failures or network errors.
export async function fetchJson(url, { headers = {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: controller.signal,
      });
      if (res.status === 404) return { status: 404, data: null };
      if (res.ok) return { status: res.status, data: await res.json() };
      if (res.status === 429 || res.status >= 500) {
        const retryAfterSec = Number(res.headers.get('retry-after')) || 2 ** attempt;
        lastError = new Error(`HTTP ${res.status} (attempt ${attempt}): ${url}`);
        if (attempt < MAX_RETRIES) {
          await sleep(retryAfterSec * 1000);
          continue;
        }
      }
      throw new Error(`HTTP ${res.status}: ${url}`);
    } catch (err) {
      lastError = err;
      const retryable = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND';
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`Request failed after ${MAX_RETRIES} attempts: ${url}`);
}

// Run async tasks with at most `concurrency` in flight and at least
// `minIntervalMs` between consecutive task starts.
export function createPool(concurrency, minIntervalMs = 100) {
  const queue = [];
  let workers = 0;
  let lastStart = 0;

  async function worker() {
    while (queue.length > 0) {
      const task = queue.shift();
      const wait = Math.max(0, lastStart + minIntervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      try {
        task.resolve(await task.fn());
      } catch (err) {
        task.reject(err);
      }
    }
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      if (workers < concurrency) {
        workers += 1;
        worker().finally(() => {
          workers -= 1;
        });
      }
    });
  };
}
