# Argo XHTTP + ShadowQuic (Shoes)

This Node.js launcher runs the bundled x86_64 Linux musl build of Shoes with an optional direct ShadowQuic inbound and/or Cloudflare Argo XHTTP tunnel. ShadowQuic uses JLS authentication and disguises unauthenticated QUIC traffic as `www.apple.com:443`; it does not need TLS certificates.

## Settings

Edit the constants near the top of `index.js`:

- `SHADOWQUIC_PORT`: UDP port for ShadowQuic. Leave empty to disable this inbound.
- `SHADOWQUIC_USERNAME`: client username. Leave empty to use the generated UUID.
- `SHADOWQUIC_PASSWORD`: client password. **Required when `SHADOWQUIC_PORT` is set**; startup fails if blank.
- `ARGO_DOMAIN` and `ARGO_AUTH`: set both to enable the optional Cloudflare tunnel and XHTTP/VLESS inbound.

The camouflage SNI and upstream are fixed to `www.apple.com` and `www.apple.com:443`. The launcher writes Shoes configuration to `.tmp/shoes.yaml` and, when ShadowQuic is enabled, writes a matching ShadowQuic reference-client configuration to `shadowquic-client.json` with private file permissions. The Base64 subscription file contains the Argo XHTTP link when Argo is enabled.

Run on Linux x86_64 with Node.js 18 or newer:

```sh
npm test
npm start
```
