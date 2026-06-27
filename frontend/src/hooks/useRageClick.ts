import { useEffect, useRef } from 'react';
import { sendTelemetry } from '../utils/telemetry';

interface RageClickHookProps {
  sessionId: string;
  userId?: string;
  currentRoute: string;
}

export function useRageClick({ sessionId, userId, currentRoute }: RageClickHookProps): void {
  const clickHistory = useRef<{ time: number; target: HTMLElement | null }[]>([]);
  const lastTriggered = useRef<number>(0);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const now = Date.now();
      const target = e.target as HTMLElement | null;

      clickHistory.current.push({ time: now, target });

      // Keep only clicks within the last 1000ms
      clickHistory.current = clickHistory.current.filter(click => now - click.time <= 1000);

      if (clickHistory.current.length >= 5) {
        // Cooldown of 3 seconds to avoid flooding
        if (now - lastTriggered.current > 3000) {
          lastTriggered.current = now;
          console.warn('[Rage Click Sensor] Rage click detected!');
          
          sendTelemetry({
            session_id: sessionId,
            user_id: userId,
            current_route: currentRoute,
            timestamp: new Date().toISOString(),
            revision_id: 'v1',
            is_rage_click: 1,
            is_maigo: 0,
            schema_validation_error: 0,
            stay_duration_seconds: 0,
            regenerate_count: 0
          });

          // Reset history on trigger
          clickHistory.current = [];
        }
      }
    };

    window.addEventListener('click', handleClick);
    return () => {
      window.removeEventListener('click', handleClick);
    };
  }, [sessionId, userId, currentRoute]);
}
