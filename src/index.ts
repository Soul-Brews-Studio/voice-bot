#!/usr/bin/env bun
import { startBotProcess } from "./bot/index.ts";

startBotProcess().catch((error) => {
  console.error(error);
  process.exit(1);
});
