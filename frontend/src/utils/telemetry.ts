import type { UXEvent } from '../types';

/**
 * Sends a telemetry event asynchronously and non-blockingly to the backend.
 * Uses navigator.sendBeacon where supported, falling back to fetch with keepalive: true.
 */
export function sendTelemetry(event: UXEvent): void {
  const url = '/api/telemetry';
  const payload = JSON.stringify(event);

  console.log('[Telemetry Service] Queueing event:', event);

  try {
    if (typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' });
      const queued = navigator.sendBeacon(url, blob);
      if (queued) {
        console.log('[Telemetry Service] Sent via sendBeacon');
        return;
      }
    }
  } catch (err) {
    console.warn('[Telemetry Service] sendBeacon failed, falling back to fetch:', err);
  }

  // Fallback to fetch with keepalive: true
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: payload,
    keepalive: true,
  })
    .then(res => {
      if (!res.ok) {
        console.warn(`[Telemetry Service] HTTP error: ${res.status}`);
      }
    })
    .catch(err => {
      console.error('[Telemetry Service] Fetch error:', err);
    });
}
