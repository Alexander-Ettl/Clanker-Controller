'use strict';

// Shared native recording: Electron webviews cannot request microphone permissions.
module.exports = require('../../voice-router/lib/native-capture.cjs');
