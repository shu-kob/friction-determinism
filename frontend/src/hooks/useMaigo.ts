import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { sendTelemetry } from '../utils/telemetry';

interface MaigoHookProps {
  sessionId: string;
  userId?: string;
}

export function useMaigo({ sessionId, userId }: MaigoHookProps): void {
  const location = useLocation();
  const routeHistory = useRef<{ route: string; time: number }[]>([]);
  const lastTriggered = useRef<number>(0);

  useEffect(() => {
    const now = Date.now();
    const currentPath = location.pathname;

    // Do not count consecutive duplicate path visits (e.g. reload or redundant links)
    const lastEntry = routeHistory.current[routeHistory.current.length - 1];
    if (lastEntry && lastEntry.route === currentPath) {
      return;
    }

    routeHistory.current.push({ route: currentPath, time: now });

    // Filter to retain only visits in the last 30 seconds
    routeHistory.current = routeHistory.current.filter(entry => now - entry.time <= 30000);

    // Transitions count is length - 1. We require >= 4 transitions (meaning >= 5 route steps)
    if (routeHistory.current.length >= 5) {
      const distinctRoutes = new Set(routeHistory.current.map(entry => entry.route));

      if (distinctRoutes.size >= 3) {
        // Cooldown of 10 seconds to prevent event flooding
        if (now - lastTriggered.current > 10000) {
          lastTriggered.current = now;
          console.warn('[Maigo Sensor] Maigo route ping-pong detected!', routeHistory.current.map(e => e.route).join(' -> '));

          sendTelemetry({
            session_id: sessionId,
            user_id: userId,
            current_route: currentPath,
            timestamp: new Date().toISOString(),
            revision_id: 'v1',
            is_rage_click: 0,
            is_maigo: 1,
            schema_validation_error: 0,
            stay_duration_seconds: 0,
            regenerate_count: 0
          });

          // Reset history on detection
          routeHistory.current = [];
        }
      }
    }
  }, [location.pathname, sessionId, userId]);
}
