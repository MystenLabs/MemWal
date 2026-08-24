export const isProductionEnvironment = process.env.NODE_ENV === "production";
export const isDevelopmentEnvironment = process.env.NODE_ENV === "development";

/**
 * Playwright / CI test runner only. Fail-closed in production so a leaked
 * PLAYWRIGHT=True on Railway cannot flip assertDelegateAccountBinding onto
 * the fixture-key mock (which would let anyone log in as 0x00… / 0x40…).
 */
export const isTestEnvironment =
  process.env.NODE_ENV !== "production" &&
  Boolean(
    process.env.PLAYWRIGHT_TEST_BASE_URL ||
      process.env.PLAYWRIGHT ||
      process.env.CI_PLAYWRIGHT
  );
