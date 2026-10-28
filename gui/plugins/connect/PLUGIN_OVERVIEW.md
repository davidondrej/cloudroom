Cloudroom Connect opens Cloudroom from your phone or another computer, at a private `https://<id>.cloudroom.run` address. It runs on Cloudroom's own relay ([ADR 0184](../../../docs/adr/0184-own-the-mobile-connection.md)).

## What you get

- Remote access through an outbound tunnel. No router changes or open inbound ports.
- Phone setup: open cloudroom.dev/m on your phone and sign in with your Cloudroom account. The app runs at `app.cloudroom.run` ([ADR 0268](../../../docs/adr/0268-one-phone-app-set-up-at-cloudroom-dev-m.md)).
- Port shares for local HTTP servers, open only on your signed-in phones and browsers.
- The Cloudroom mobile app: after signing in, use Add to Home Screen or Install app. This is the PWA, not BB's native mobile app.

## Setup and commands

Connect registers this Mac by itself once you are signed in to Cloudroom. Settings → Cloudroom Connect shows a QR code for cloudroom.dev/m, and `room-cli connect phone` prints the link. Phones stay signed in until `room-cli connect sign-out-phones` or Sign out all phones. Disable the plugin to stop remote access.

Agents use `room-cli connect expose <port>` to share previews. Inspect with `room-cli connect status` and `room-cli connect shares`; stop a share with `room-cli connect unexpose <port>`.

Your other Macs show up in Settings → Machines by themselves. Open one, or let this Mac run threads on it. Remote hosts reach this Mac through the same relay with their own revocable credential.
