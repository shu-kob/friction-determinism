import { test, expect } from '@playwright/test';

/**
 * 混沌（カオス）シナリオ 3: 200 OKの嘘 ＆ Canary自動ロールバック実証
 * 
 * 1. 管理画面 (/admin) から新リビジョン v2-experimental を Canary 5% 展開
 * 2. ユーザーチャット画面 (/) で故意に壊れたJSONを返すバグモード (Bug Mode) をONにして送信
 * 3. HTTP 200 OK が返るが、クライアント側で Zod スキーマエラーが発生
 * 4. 表側: ErrorBoundary が作動し、スマート・フォールバック UI がユーザー画面を救済
 * 5. 裏側: schema_validation_error = 1 がテレメトリパイプラインへ即時裏流し
 * 6. インフラ側: Canary 違反を検知し、Cloud Run トラフィックを 1秒で 0% へ自動ロールバック
 * 7. Gemini 4 Argon によるポストモーテム (RCA & プロンプト修正案) の生成を検証
 */
test.describe('Chaos Scenario 3: Canary 5% -> Smart Fallback -> Automated Rollback & Postmortem', () => {
  test('should trigger automated rollback on schema corruption during Canary and generate postmortem', async ({ page }) => {
    // sendBeacon を fetch フォールバックに切り替え、Playwright の確実なリクエストインターセプトを担保
    await page.addInitScript(() => {
      // @ts-ignore
      navigator.sendBeacon = null;
    });

    let schemaErrorCaptured: any = null;
    page.on('request', req => {
      if (req.url().includes('/api/telemetry') && req.method() === 'POST') {
        try {
          const postData = req.postDataJSON() || JSON.parse(req.postData() || '{}');
          if (postData && postData.schema_validation_error === 1) {
            schemaErrorCaptured = postData;
          }
        } catch {}
      }
    });

    // -------------------------------------------------------------
    // ステップ 1: 管理画面 (/admin) で Canary 5% 展開を発火
    // -------------------------------------------------------------
    await page.goto('/admin');
    await expect(page.locator('h1')).toContainText('UXOps Cockpit');

    // Deploy ボタンの表示を待ってクリック
    const deployBtn = page.locator('button:has-text("Deploy v2-experimental to Canary (5%)")');
    await deployBtn.waitFor({ state: 'visible', timeout: 10000 });
    await deployBtn.click();

    // トラフィック分割が Canary (v1: 95%, v2: 5%) になったことを確認
    await expect(page.locator('span.text-purple')).toContainText('v2-experimental [New]: 5%');
    await expect(page.locator('text=Current Phase: canary')).toBeVisible();

    // -------------------------------------------------------------
    // ステップ 2: チャット画面 (/) へ遷移し、スキーマ破壊バグを注入
    // -------------------------------------------------------------
    await page.goto('/');

    // 「Bug Mode: ON (Malformed JSON)」のトグルスイッチをクリック
    await page.locator('label.switch').click();
    await expect(page.locator('text=Bug Mode: ON')).toBeVisible();

    // チャット入力を送信
    const chatInput = page.locator('input[placeholder*="Type your message"]');
    await chatInput.fill('最新のシステム稼働状況とメトリクスをJSON形式で教えてください');
    await page.click('button.btn-primary:has-text("Send")');

    // -------------------------------------------------------------
    // ステップ 3 & 4: 表側の Smart Fallback UI ＆ 裏側のテレメトリ検証
    // -------------------------------------------------------------
    // テレメトリの検証 (schema_validation_error === 1)
    await expect.poll(() => schemaErrorCaptured, { timeout: 10000 }).not.toBeNull();
    console.log('[Playwright Chaos 3] Intercepted Schema Error Telemetry:', schemaErrorCaptured);
    expect(schemaErrorCaptured.schema_validation_error).toBe(1);

    // 表側でホワイトアウトせず、Smart Fallback UI (fallback-box) が表示されていることを検証
    const smartFallback = page.locator('.fallback-box');
    await expect(smartFallback).toBeVisible();
    await expect(smartFallback).toContainText('Smart Fallback Active: AI is taking a deep breath');

    // -------------------------------------------------------------
    // ステップ 5 & 6: 管理画面で 1秒自動ロールバックの完了を検証
    // -------------------------------------------------------------
    await page.goto('/admin');

    // トラフィックが 100% v1 / 0% v2 へ即時自動ロールバックされたことをアサート
    await expect(page.locator('span.text-cyan')).toContainText('v1 [Stable]: 100%');
    await expect(page.locator('span.text-purple')).toContainText('v2-experimental [New]: 0%');
    await expect(page.locator('text=Rollback Triggered 🚨').first()).toBeVisible();

    // -------------------------------------------------------------
    // ステップ 7: Gemini 4 Argon による事後分析ポストモーテムの生成検証
    // -------------------------------------------------------------
    const postmortemBtn = page.locator('button:has-text("Postmortem with 4 Argon")');
    await postmortemBtn.click();

    // モーダルが浮き上がり、Gemini 4 Argon の RCA レポートが表示されることを検証
    const modal = page.locator('text=Gemini 4 Argon: Automated Incident Postmortem');
    await expect(modal).toBeVisible();

    // レポート内に RCA (根本原因分析) や 改善プロンプト提案 (Diff) が含まれていることをアサート
    const modalContent = page.locator('.glass-panel:has-text("UXOps Postmortem Report")');
    await expect(modalContent).toContainText('根本原因分析');
    await expect(modalContent).toContainText('改善プロンプト提案');
    console.log('[Playwright Chaos 3] Verified Gemini 4 Argon Autonomous Postmortem Generation!');
  });
});
