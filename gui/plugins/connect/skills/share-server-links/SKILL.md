---
name: share-server-links
description: "Expose a local HTTP server through Cloudroom Connect and give the user its remotely accessible URL."
disable-model-invocation: true
---

# Share local server links via cloudroom connect

When you start an HTTP server the user should open, give them a connect share
URL — not a localhost URL. Shares work from threads running on any enrolled
host, and the command resolves the thread's host automatically.

1. Check status: run `room-cli connect status --json`. If not paired / not
   connected, give the localhost URL. Connect sets itself up once the user is
   signed in to Cloudroom.
2. From the thread that started the HTTP server, run
   `room-cli connect expose <port>`. It prints that host's share URL. Use
   `--host <name-or-id>` only when you intentionally need another enrolled
   host; outside a thread, sharing defaults to the machine running the
   Cloudroom server.
3. Give the returned URL to the user as a markdown link. It opens on the
   user's signed-in phones and browsers; it is not a public internet link.
   To set up a new phone, send the user to cloudroom.dev/m to sign in
   (`room-cli connect phone` prints the link).
4. When the server stops, run `room-cli connect unexpose <port>` from the same
   thread (or with the same `--host`) so the share is cleaned up. Use
   `room-cli connect shares [--host <name-or-id>]` to inspect that host's shares.

Server-host shares use `https://<server-label>--<port>.<base-domain>` through
the server tunnel. Other enrolled hosts use
`https://<machine-label>--<port>.<base-domain>` through their daemon. If a
machine was not enrolled through Connect, expose fails with instructions to
remove and re-add it under Settings > Machines.

## Apps that build absolute URLs

- The app sees `Host: 127.0.0.1:<port>` and `X-Forwarded-Proto: https`.
- A same-site `Origin` arrives as `http://127.0.0.1:<port>`.
- No `X-Forwarded-Host` arrives.
- So Rails redirects to `https://127.0.0.1:<port>` and fails CSRF on form posts.
- Fix it in the app, in development only.
- Set `SHARE_URL` to the URL from `room-cli connect shares`.
- The `https` check leaves local browsing unchanged.

Rails, in `config/environments/development.rb`:

```ruby
if (share = ENV["SHARE_URL"])
  config.hosts << URI(share).host
  config.middleware.insert_before 0, Class.new {
    define_method(:initialize) { |app| @app = app }
    define_method(:call) do |env|
      if env["HTTP_X_FORWARDED_PROTO"] == "https"
        env["HTTP_X_FORWARDED_HOST"] = URI(share).host
        env["HTTP_ORIGIN"] = share if env["HTTP_ORIGIN"] == "http://#{env["HTTP_HOST"]}"
      end
      @app.call(env)
    end
  }
end
```

Django:

- Add a first middleware that makes the same two `request.META` changes.
- Set `ALLOWED_HOSTS = [".localhost", "127.0.0.1", "[::1]", <share host>]`.
- Keep the first three: a non-empty list turns off Django's local default.
- Set `USE_X_FORWARDED_HOST = True`.
- Set `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")`.

## Agent instructions setting

Settings → Machines → Cloudroom Connect has a "Tell agents about remote access"
toggle, enabled by default. Use
`room-cli plugin config connect set sendRemoteInstructions false` to suppress the
remote-access message, or `true` to restore it. This controls only the message;
sharing still works. The message otherwise requires active or recent remote
usage. Changes apply when session instructions are next assembled.
