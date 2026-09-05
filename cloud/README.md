# ShipChamber cloud services

Cloudflare Workers that back the app. Deploy with `wrangler` (Node 22+):

| Worker | Live URL | Purpose |
|---|---|---|
| `api/` | https://shipchamber-api.getlaunchpod.workers.dev | Lifetime licenses (D1), Dodo Payments webhook, update check, push relay stub |
| `relay/` | https://shipchamber-relay.getlaunchpod.workers.dev | Private relay (Layer 1 broker, Durable Object per host) |

## api

```
cd cloud/api
wrangler d1 execute shipchamber-licenses --remote --file schema.sql
wrangler secret put DODO_WEBHOOK_SECRET   # from the Dodo dashboard webhook
wrangler secret put ADMIN_TOKEN           # any long random string
wrangler deploy
```

Optional var `DODO_PRODUCT_ID` restricts license issuance to one product.

Endpoints:

- `POST /v1/license/{activate,validate,deactivate}` `{ key, installId }` — used by the app.
- `GET  /v1/license/claim?payment_id=` — thank-you page fetches the key after checkout.
- `POST /v1/webhooks/dodo` — `payment.succeeded` issues a key, refunds/disputes revoke it.
- `POST /v1/admin/license/{issue,revoke}` — `Authorization: Bearer <ADMIN_TOKEN>`.
- `POST /v1/update/check` — latest GitHub release of `bytepassperks/shipchamber`.
- `POST /v1/push/send` — returns 501 until an APNs key for a ShipChamber iOS app exists.

## relay

```
cd cloud/relay && wrangler deploy
```

Protocol: `packages/web/server/lib/relay/DOCUMENTATION.md`. Host sockets are
verified with the ECDSA signature over `${ts}.${serverId}.${role}.${connectionId}`;
client sockets carry no auth (the E2EE tunnel authenticates end-to-end).

## Custom domain

Once `shipchamber.com` is on this Cloudflare account, add custom domains
`api.shipchamber.com` and `relay.shipchamber.com` to the two Workers and switch
the defaults in `packages/web/server/lib/{license,relay}/service.js`,
`packages/web/server/lib/package-manager.js`,
`packages/web/server/lib/notifications/apns-runtime.js` and `packages/vscode/src/bridge.ts`.
