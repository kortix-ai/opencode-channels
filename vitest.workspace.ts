import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/core",
  "packages/slack",
  "packages/telegram",
  "packages/discord",
  "packages/fs",
]);
