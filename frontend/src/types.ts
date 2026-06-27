import { z } from 'zod';

export const UXEventSchema = z.object({
  session_id: z.string().uuid(),
  user_id: z.string().optional(),
  current_route: z.string(),
  timestamp: z.string().datetime(),
  revision_id: z.string().default('v1'), // Defaults to v1
  
  // Deterministic friction signals (0 or 1)
  is_rage_click: z.number().int().min(0).max(1),
  is_maigo: z.number().int().min(0).max(1),
  schema_validation_error: z.number().int().min(0).max(1),
  
  // Quantitative metrics
  stay_duration_seconds: z.number().min(0),
  regenerate_count: z.number().int().nonnegative(),
  raw_error_message: z.string().optional()
});

export type UXEvent = z.infer<typeof UXEventSchema>;

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  isBroken?: boolean;
}
