'use strict';

let readEnabled = () => false;

function configureCliTelemetry(readSetting) {
  readEnabled = readSetting;
}

function cliTelemetry(agent) {
  if (readEnabled() !== true) {
    if (agent === 'codex') return {
      args: ['-c', 'analytics.enabled=false', '-c', 'otel.exporter=none', '-c', 'otel.metrics_exporter=none', '-c', 'otel.trace_exporter=none'],
      env: {},
    };
    if (agent === 'claude') return {
      args: [],
      env: { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0' },
    };
  }
  return { args: [], env: {} };
}

module.exports = { configureCliTelemetry, cliTelemetry };
