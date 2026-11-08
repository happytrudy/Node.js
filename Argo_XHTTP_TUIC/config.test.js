"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildConfig, parsePort, validUuid } = require("./index");

const env = {
  TUIC_PORT: "4433",
  CERT_DOMAIN: "tuic.example.com",
  CF_API_TOKEN: "dummy-cloudflare-token",
  ACME_TERMS_OF_SERVICE: "https://ca.example.test/terms-v1.pdf",
  ARGO_PORT: "8001",
  ARGO_DOMAIN: "tunnel.example.com",
  ARGO_AUTH: "dummy-tunnel-token",
};

test("emits shoes XHTTP and TUIC configuration with DNS-01 cert source", () => {
  const result = buildConfig(env, {
    filePath: "/srv/argo/.tmp",
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    tuicPassword: "generated-password",
  });
  assert.equal(result.config.length, 3);
  assert.equal(result.config[0].type, "acme");
  assert.equal(result.config[0].challenge.provider, "cloudflare");
  assert.equal(result.config[0].challenge.api_token, "dummy-cloudflare-token");
  assert.equal(result.config[1].protocol.type, "tuic");
  assert.equal(result.config[1].quic_settings.certificate_source, "tuic-acme");
  assert.equal(result.config[2].protocol.type, "xhttp");
  assert.equal(result.config[2].protocol.protocol.type, "vless");
  assert.equal(result.config[2].protocol.path, "/550e8400-e29b-41d4-a716-446655440000-xhttp");
  assert.equal(result.config[2].address, "127.0.0.1:8001");
  assert.ok(JSON.stringify(result.config).includes("dummy-cloudflare-token"));
  assert.equal(result.config[0].state_dir, "/srv/argo/.tmp/certificates");
});

test("uses an explicit XHTTP path when provided", () => {
  const result = buildConfig({ ARGO_DOMAIN: "tunnel.example.com", ARGO_AUTH: "token", XHTTP_PATH: "/custom" }, {
    uuid: "550e8400-e29b-41d4-a716-446655440000",
  });
  assert.equal(result.config[0].protocol.path, "/custom");
});

test("supports Argo-only operation without creating ACME or TUIC entries", () => {
  const result = buildConfig({ ARGO_DOMAIN: "tunnel.example.com", ARGO_AUTH: "token" }, {
    filePath: "/tmp/argo", uuid: "550e8400-e29b-41d4-a716-446655440000",
  });
  assert.equal(result.config.length, 1);
  assert.equal(result.config[0].protocol.type, "xhttp");
});

test("supports TUIC-only operation without an Argo origin", () => {
  const result = buildConfig({ ...env, ARGO_DOMAIN: "", ARGO_AUTH: "" }, {
    uuid: "550e8400-e29b-41d4-a716-446655440000", tuicPassword: "password",
  });
  assert.equal(result.config.length, 2);
  assert.equal(result.enableArgo, false);
});

test("rejects invalid ports, domains, and invalid tunnel protocol", () => {
  assert.throws(() => parsePort("65536", "TUIC_PORT"));
  assert.throws(() => buildConfig({ ...env, CERT_DOMAIN: "*.example.com" }));
  assert.doesNotThrow(() => buildConfig({ ...env, ACME_TERMS_OF_SERVICE: "" }));
  assert.throws(() => buildConfig({ ...env, ARGO_PROTOCOL: "http2" }));
});

test("UUID validation rejects invalid values", () => {
  assert.equal(validUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(validUuid("bad"), false);
});
