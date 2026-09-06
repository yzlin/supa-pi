import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const skillPath = join(repositoryRoot, "skills", "e2e-testing", "SKILL.md");

const originalSetupBlock = `## Playwright Configuration

\`\`\`typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'playwright-results.xml' }],
    ['json', { outputFile: 'playwright-results.json' }]
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
})
\`\`\`
`;

const originalCiBlock = `## CI/CD Integration

\`\`\`yaml
# .github/workflows/e2e.yml
name: E2E Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
        env:
          BASE_URL: \${{ vars.STAGING_URL }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
\`\`\`
`;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("E2E selective reference contract", () => {
  it("routes setup/configuration and CI work to distinct resolvable references", () => {
    const skill = read(skillPath);
    const setupLink = "references/setup.md";
    const ciLink = "references/ci.md";

    expect(skill).toContain(
      `For Playwright setup or configuration work, read [Setup and configuration](${setupLink}).`
    );
    expect(skill).toContain(
      `For CI/CD workflow work, read [CI/CD workflow](${ciLink}).`
    );

    for (const link of [setupLink, ciLink]) {
      const referencePath = resolve(dirname(skillPath), link);
      expect(existsSync(referencePath)).toBe(true);
      expect(referencePath.startsWith(dirname(skillPath))).toBe(true);
    }
  });

  it("keeps ordinary flow-test work from loading both specialized references automatically", () => {
    const skill = read(skillPath);

    expect(skill).toContain(
      "For ordinary E2E test design, implementation, debugging, artifacts, or reporting, do not load either reference automatically."
    );
    expect(skill.match(/references\/setup\.md/g)).toHaveLength(1);
    expect(skill.match(/references\/ci\.md/g)).toHaveLength(1);
  });

  it("preserves the original moved blocks byte-for-byte in their references", () => {
    const setup = read(
      join(repositoryRoot, "skills", "e2e-testing", "references", "setup.md")
    );
    const ci = read(
      join(repositoryRoot, "skills", "e2e-testing", "references", "ci.md")
    );

    expect(digest(setup)).toBe(digest(originalSetupBlock));
    expect(digest(ci)).toBe(digest(originalCiBlock));
  });

  it("does not duplicate moved recipes in the entrypoint", () => {
    const skill = read(skillPath);

    expect(skill).not.toContain(originalSetupBlock);
    expect(skill).not.toContain(originalCiBlock);
    expect(skill).not.toContain("npm run dev");
    expect(skill).not.toContain("actions/upload-artifact@v4");
  });

  it("retains the remaining workflow, examples, testing rules, and critical-flow guidance", () => {
    const skill = read(skillPath);

    for (const retained of [
      "## Test File Organization",
      "## Page Object Model (POM)",
      "await page.waitForLoadState('networkidle')",
      "## Test Structure",
      "## Flaky Test Patterns",
      "npx playwright test tests/search.spec.ts --repeat-each=10",
      "// Bad: arbitrary timeout",
      "await page.waitForTimeout(5000)",
      "## Artifact Management",
      "## Test Report Template",
      "## Wallet / Web3 Testing",
      "## Financial / Critical Flow Testing",
      "test.skip(process.env.NODE_ENV === 'production', 'Skip on production')",
    ]) {
      expect(skill).toContain(retained);
    }
  });
});
