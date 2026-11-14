'use strict';

// Shared native recording: Electron webviews cannot request microphone permissions.
// Installed packages bundle it at ./voice-router/lib (scripts/install-extension.mjs); a source checkout uses the sibling folder.
const fs = require('node:fs');
const path = require('node:path');

const bundled = path.join(__dirname, '..', 'voice-router', 'lib', 'native-capture.cjs');
module.exports = require(fs.existsSync(bundled) ? bundled : '../../voice-router/lib/native-capture.cjs');
