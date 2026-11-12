import { test, expect } from '@playwright/test';

/**
 * 混沌（カオス）シナリオ 2: 探索迷子（ルーティング・ピンポン往復）の決定論的検証
 * 
 * 目的の画面やAIの回答履歴に辿り着けず、30秒間に3画面以上を4回往復（5ステップ遷移）した
 * ユーザーの迷走状態をシミュレート。
 * クライアントのセンサー（useMaigo hook）が発火し、
 * /api/telemetry に対して is_maigo = 1 を送信することを決定論的にアサートする。
 */
test.describe('Chaos Scenario 2: Maigo (探索迷子・ピンポン遷移) Verification', () => {
  test('should detect navigation ping-pong across 3+ routes and dispatch is_maigo = 1', async ({ page }) => {
    // sendBeacon を fetch フォールバックに切り替え、Playwright の確実なリクエストインターセプトを担保
    await page.addInitScript(() => {
      // @ts-ignore
      navigator.sendBeacon = null;
    });

    // 1. /api/telemetry への is_maigo = 1 送信を待ち受けるPromiseを定義
    let capturedPayload: any = null;
    page.on('request', request => {
      if (request.url().includes('/api/telemetry') && request.method() === 'POST') {
        try {
          const postData = request.postDataJSON() || JSON.parse(request.postData() || '{}');
          if (postData && postData.is_maigo === 1) {
            capturedPayload = postData;
          }
        } catch {}
      }
    });

    // 初期ルートへアクセス (Step 1: /)
    await page.goto('/');
    await expect(page.locator('h2')).toContainText('Active Session Sandbox');

    // 2. ユーザーの迷走ナビゲーション（カオス注入: / -> /settings -> /profile -> /settings -> /）
    // Step 2: -> /settings
    await page.locator('nav a[href="/settings"]').click();
    await page.waitForURL('**/settings');
    await expect(page.locator('h1')).toContainText('System Settings');

    // Step 3: -> /profile
    await page.locator('nav a[href="/profile"]').click();
    await page.waitForURL('**/profile');
    await expect(page.locator('h1')).toContainText('User Profile');

    // Step 4: -> /settings
    await page.locator('nav a[href="/settings"]').click();
    await page.waitForURL('**/settings');
    await expect(page.locator('h1')).toContainText('System Settings');

    // Step 5: -> / (ここで 5ステップ & 3つの個別画面達成 -> 発火)
    await page.locator('nav a[href="/"]').click();
    await page.waitForURL(url => url.pathname === '/');

    // 3. テレメトリの受信を待機・アサート
    await expect.poll(() => capturedPayload, { timeout: 10000 }).not.toBeNull();
    console.log('[Playwright Chaos 2] Intercepted Maigo Telemetry:', capturedPayload);
    expect(capturedPayload.is_maigo).toBe(1);
    expect(capturedPayload.current_route).toBe('/');
  });
});
