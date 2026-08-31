#!/usr/bin/env node
import { startApiServer } from '../src/apiServer.js';

try {
  startApiServer();
} catch (error) {
  console.error(`API server failed to start: ${error.message}`);
  process.exitCode = 1;
}
