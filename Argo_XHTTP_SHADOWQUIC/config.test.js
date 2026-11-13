"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { buildConfig, buildShadowquicClient, parsePort, validUuid, getIdentity } = require("./index");

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const argo = { ARGO_DOMAIN: "tunnel.example.com", ARGO_AUTH: "dummy-tunnel-token" };

 test("emits certificate-free ShadowQuic and XHTTP inbounds", () => {
  const result = buildConfig({ ...argo, SHADOWQUIC_PORT: "4433", SHADOWQUIC_PASSWORD: "test-password" }, {
    uuid: UUID, shadowquicUsername: "alice", shadowquicPassword: "test-password",
  });
  assert.equal(result.config.length, 2);
  assert.deepEqual(result.config[0], {
    address: "[::]:4433",
    transport: "quic",
    protocol: {
      type: "shadowquic",
      users: [{ username: "alice", password: "test-password" }],
      server_name: "www.apple.com",
      jls_upstream: "www.apple.com:443",
    },
    rules: ["allow-all-direct"],
  });
  assert.equal(result.config[1].protocol.type, "xhttp");
  assert.equal(result.config[1].protocol.protocol.type, "vless");
  assert.equal(result.config[1].protocol.path, `/${UUID}-xhttp`);
  assert.equal(result.config[1].address, "127.0.0.1:8001");
  assert.equal(result.shadowquicUsername, "alice");
  assert.equal(result.serverName, "www.apple.com");
  assert.equal(JSON.stringify(result.config).includes("certificate"), false);
  assert.equal(JSON.stringify(result.config).includes("acme"), false);
});

test("allows a custom ShadowQuic username and password without Argo", () => {
  const result = buildConfig({ SHADOWQUIC_PORT: "7443", SHADOWQUIC_USERNAME: "my-user", SHADOWQUIC_PASSWORD: "my-password" }, { uuid: UUID });
  assert.equal(result.config.length, 1);
  assert.equal(result.config[0].protocol.users[0].username, "my-user");
  assert.equal(result.config[0].protocol.users[0].password, "my-password");
  assert.equal(result.enableArgo, false);
});

test("creates a matching reference-client outbound fragment", () => {
  const settings = buildConfig({ SHADOWQUIC_PORT: "4433", SHADOWQUIC_PASSWORD: "test-password" }, {
    uuid: UUID, shadowquicUsername: "alice", shadowquicPassword: "test-password",
  });
  assert.deepEqual(buildShadowquicClient(settings, "203.0.113.8"), {
    outbounds: [{
      tag: "shadowquic-outbound",
      type: "shadowquic",
      addr: "203.0.113.8:4433",
      username: "alice",
      password: "test-password",
      "server-name": "www.apple.com",
    }],
  });
});

test("uses an explicit XHTTP path and supports Argo-only operation", () => {
  const result = buildConfig({ ...argo, XHTTP_PATH: "/custom" }, { uuid: UUID });
  assert.equal(result.config.length, 1);
  assert.equal(result.config[0].protocol.path, "/custom");
  assert.equal(result.enableShadowquic, false);
});

test("requires at least one inbound and both Argo tunnel values", () => {
  assert.throws(() => buildConfig({}), /Set SHADOWQUIC_PORT/);
  assert.throws(() => buildConfig({ ARGO_DOMAIN: "tunnel.example.com" }), /must be set together/);
});

test("rejects invalid ports, hostnames, and XHTTP paths", () => {
  assert.throws(() => parsePort("65536", "SHADOWQUIC_PORT"));
  assert.throws(() => buildConfig({ SHADOWQUIC_PORT: "443", ARGO_DOMAIN: "tunnel.example.com", ARGO_AUTH: "token", XHTTP_PATH: "bad" }, { uuid: UUID }));
  assert.throws(() => buildConfig({ ARGO_DOMAIN: "*.example.com", ARGO_AUTH: "token" }, { uuid: UUID }));
  assert.throws(() => buildConfig({ ARGO_DOMAIN: "tunnel.example.com", ARGO_AUTH: "token", ARGO_PROTOCOL: "http2" }, { uuid: UUID }));
});

test("validates UUIDs, defaults username to UUID, and requires a ShadowQuic password", () => {
  assert.equal(validUuid(UUID), true);
  assert.equal(validUuid("bad"), false);
  assert.throws(() => getIdentity("container-host-123"), /Set SHADOWQUIC_PASSWORD/);
  const identity = getIdentity("container-host-123", { requireShadowQuicPassword: false });
  assert.equal(identity.username, identity.uuid);
  assert.equal(identity.password, "");
  assert.throws(() => buildConfig({ SHADOWQUIC_PORT: "4433" }, { uuid: UUID }), /Set SHADOWQUIC_PASSWORD/);
});


test("bundled shoes validates the generated ShadowQuic inbound", () => {
  const result = buildConfig({ SHADOWQUIC_PORT: "4433", SHADOWQUIC_PASSWORD: "test-password" }, {
    uuid: UUID, shadowquicUsername: "alice", shadowquicPassword: "test-password",
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shoes-shadowquic-"));
  const configPath = path.join(directory, "config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(result.config));
    const binary = path.join(__dirname, "shoes-x86_64-unknown-linux-musl");
    const output = execFileSync(binary, ["check", configPath], { encoding: "utf8" });
    assert.match(output, /configuration|config|valid/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
