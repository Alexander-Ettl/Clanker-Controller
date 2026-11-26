'use strict';

// git reads extra config from GIT_CONFIG_COUNT and GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n.
// A parent that started the editor from a Codex shell hands it that set with the empty
// values missing (the "reset the credential helper" entries), and then every git call
// fails with "missing config value GIT_CONFIG_VALUE_0". Fill missing values with "" (what
// they were); drop the whole set when a key is missing or the count is not a number.
function repairGitConfigEnv(env = process.env) {
  const raw = env.GIT_CONFIG_COUNT;
  if (raw === undefined) return { repaired: false, dropped: false };
  const count = /^\d+$/.test(String(raw)) ? Number(raw) : -1;
  let filled = 0;
  let broken = count < 0 || count > 1000;
  for (let i = 0; !broken && i < count; i += 1) {
    if (env[`GIT_CONFIG_KEY_${i}`] === undefined) broken = true;
    else if (env[`GIT_CONFIG_VALUE_${i}`] === undefined) filled += 1;
  }
  if (broken) {
    for (const name of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete env[name];
    return { repaired: true, dropped: true };
  }
  if (!filled) return { repaired: false, dropped: false };
  for (let i = 0; i < count; i += 1) if (env[`GIT_CONFIG_VALUE_${i}`] === undefined) env[`GIT_CONFIG_VALUE_${i}`] = '';
  return { repaired: true, dropped: false, filled };
}

module.exports = { repairGitConfigEnv };
