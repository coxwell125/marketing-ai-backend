const test = require("node:test");
const assert = require("node:assert/strict");

function loadTenantModule() {
  const p = require.resolve("../dist/services/metaTenant.js");
  delete require.cache[p];
  return require("../dist/services/metaTenant.js");
}

test("resolveMetaAccountId returns requested allowed account", () => {
  process.env.META_AD_ACCOUNT_ID = "act_111";
  process.env.META_AD_ACCOUNT_IDS = "act_111,222,act_333";
  const mod = loadTenantModule();
  assert.equal(mod.resolveMetaAccountId("222"), "act_222");
});

test("resolveMetaAccountId returns default when request missing", () => {
  process.env.META_AD_ACCOUNT_ID = "act_999";
  process.env.META_AD_ACCOUNT_IDS = "act_111,act_222";
  const mod = loadTenantModule();
  assert.equal(mod.resolveMetaAccountId(), "act_111");
});

test("resolveMetaAccountId throws for disallowed account", () => {
  process.env.META_AD_ACCOUNT_ID = "act_111";
  process.env.META_AD_ACCOUNT_IDS = "act_111,act_222";
  const mod = loadTenantModule();
  assert.throws(() => mod.resolveMetaAccountId("act_999"), /not allowed/);
});

