#!/usr/bin/env node

const { spawn } = require('child_process');

const RESTART_DELAY = 3000;
const MAX_RESTARTS = 10;
const RESTART_WINDOW = 60000;

let restartCount = 0;
let restartTimestamps = [];
let isShuttingDown = false;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function shouldRestart() {
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter(ts => now - ts < RESTART_WINDOW);
  
  if (restartTimestamps.length >= MAX_RESTARTS) {
    log(`ERROR: Too many restarts (${restartTimestamps.length}) within ${RESTART_WINDOW / 1000}s. Stopping.`);
    return false;
  }
  return true;
}

function startBackend() {
  if (isShuttingDown) return;

  const child = spawn('npm', ['run', 'start:dev'], {
    cwd: __dirname + '/..',
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  log(`Started backend (PID: ${child.pid})`);

  child.on('exit', (code, signal) => {
    if (isShuttingDown) return;

    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    log(`Backend exited with ${exitReason}`);

    if (!shouldRestart()) {
      process.exit(1);
    }

    restartCount++;
    restartTimestamps.push(Date.now());
    log(`Restarting in ${RESTART_DELAY / 1000}s... (restart #${restartCount})`);

    setTimeout(startBackend, RESTART_DELAY);
  });

  child.on('error', (err) => {
    log(`Failed to start backend: ${err.message}`);
    if (!shouldRestart()) {
      process.exit(1);
    }
    setTimeout(startBackend, RESTART_DELAY);
  });

  return child;
}

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Shutting down...');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('Auto-restart wrapper started. Press Ctrl+C to stop.');
startBackend();