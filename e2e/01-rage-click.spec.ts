import { test, expect } from '@playwright/test';

/**
 * 混沌（カオス）シナリオ 1: レイジクリック（怒りの連打）の決定論的検証
 * 
 * ユーザーがUIの無反応や遅延にイライラし、1秒間に5回以上画面をクリック連打した状態をシミュレート。
 * クライアントのセンサー（useRageClick hook）がミリ秒単位で発火し、
 * /api/telemetry に対して is_rage_click = 1 を送信することを決定論的にアサートする。
 */
test.describe('Chaos Scenario 1: Rage Click (怒りの連打) Verification', () => {
  test('should detect 5+ clicks in 1 second and dispatch is_rage_click = 1 telemetry', async ({ page }) => {
    // sendBeacon を fetch フォールバックに切り替え、Playwright の確実なリクエストインターセプトを担保
    await page.addInitScript(() => {
      // @ts-ignore
      navigator.sendBeacon = null;
    });

    let rageEventCaptured: any = null;
    page.on('request', req => {
      if (req.url().includes('/api/telemetry') && req.method() === 'POST') {
        try {
          const data = req.postDataJSON() || JSON.parse(req.postData() || '{}');
          if (data && data.is_rage_click === 1) {
            rageEventCaptured = data;
          }
        } catch {}
      }
    });

    // 1. トップページへアクセス
    await page.goto('/');
    await expect(page.locator('h2')).toContainText('Active Session Sandbox');

    // 2. ユーザーの怒りの連打（カオス注入: 画面中央を高速で8回連打）
    for (let i = 0; i < 8; i++) {
      await page.mouse.click(300, 300);
      await page.waitForTimeout(40);
    }

    // 3. テレメトリの受信を待機・アサート (is_rage_click === 1)
    await expect.poll(() => rageEventCaptured, { timeout: 10000 }).not.toBeNull();
    console.log('[Playwright Chaos 1] Intercepted Rage Click Telemetry:', rageEventCaptured);
    expect(rageEventCaptured.is_rage_click).toBe(1);
    expect(rageEventCaptured.current_route).toBe('/');
  });
});
