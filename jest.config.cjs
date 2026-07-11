/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true }],
  },
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.ts"],
  // asc-contracts/ is a separate Hardhat project with its own package.json,
  // own test runner (`npm run test` inside that directory), and dependencies
  // (chai, hardhat) that are never installed at the repo root — without this,
  // testMatch above also (wrongly) picks up asc-contracts/test/*.test.ts,
  // so a plain `npm test` at the root always failed on a missing-module
  // error. CI never hit this because it always passed an explicit file path.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/asc-contracts/"],
};
