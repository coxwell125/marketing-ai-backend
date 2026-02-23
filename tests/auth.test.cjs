const test = require("node:test");
const assert = require("node:assert/strict");

function loadAuthModule() {
  const p = require.resolve("../dist/services/auth.js");
  delete require.cache[p];
  return require("../dist/services/auth.js");
}

test("getRoleForApiKey reads API_KEYS_JSON", () => {
  process.env.INTERNAL_API_KEY = "";
  process.env.API_KEYS_JSON = JSON.stringify({
    "read-key": "viewer",
    "analyst-key": "analyst",
    "admin-key": "admin",
  });
  const mod = loadAuthModule();
  assert.equal(mod.getRoleForApiKey("read-key"), "viewer");
  assert.equal(mod.getRoleForApiKey("analyst-key"), "analyst");
  assert.equal(mod.getRoleForApiKey("admin-key"), "admin");
});

test("getRoleForApiKey falls back INTERNAL_API_KEY as admin", () => {
  process.env.API_KEYS_JSON = "";
  process.env.INTERNAL_API_KEY = "legacy-key";
  const mod = loadAuthModule();
  assert.equal(mod.getRoleForApiKey("legacy-key"), "admin");
});

