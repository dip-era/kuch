const CACHE_NAME = 'pointmatrix-frame-assets-v1'

function canUseCacheStorage() {
  return typeof window !== 'undefined' && 'caches' in window
}

async function openCache() {
  if (!canUseCacheStorage()) return null
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

export async function cachedFetch(url, init) {
  const cache = await openCache()
  if (!cache) return fetch(url, init)

  const request = new Request(url, init)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (!response.ok) return response

  try {
    await cache.put(request, response.clone())
  } catch {
    // Ignore storage/quota failures and continue with the network response.
  }
  return response
}

export async function isCached(url, init) {
  const cache = await openCache()
  if (!cache) return false
  return Boolean(await cache.match(new Request(url, init)))
}
