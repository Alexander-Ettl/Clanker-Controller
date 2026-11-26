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
    // agy has no telemetry flag or variable in print mode: "Enable Telemetry" is saved with the Google account (its
    // /settings menu) and `--settings` rejects it as an unknown key. Only the feedback survey can be switched off per session.
    if (agent === 'gemini') return { args: ['--settings', '{"showFeedbackSurvey":false}'], env: {} };
  }
  return { args: [], env: {} };
}

module.exports = { configureCliTelemetry, cliTelemetry };
