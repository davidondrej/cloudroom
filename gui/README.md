# Build Cloudroom from source

You need macOS on Apple Silicon, Git, Node.js 22.19+, pnpm 9.15.9, Python 3.11+, and Xcode Command Line Tools. Building needs no Cloudroom account.

Run these from this folder:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck --filter=@cloudroom/app --filter=@cloudroom/server --filter=@cloudroom/desktop --concurrency=2
```

Keep dependency install scripts on. SQLite, file watching, and terminals use native modules. If your pnpm version differs, use `npx --yes pnpm@9.15.9`.

## Run in dev mode

Start the backend and browser UI, then Electron in a second terminal:

```sh
pnpm dev
pnpm exec turbo run dev --filter=@cloudroom/desktop
```

Dev mode uses its own ports and profile. Local agents need their own installed, signed-in CLIs. To use your own core for Cloud threads, see [connect the desktop app](../core/docs/setup.md#connect-the-desktop-app).

## Checks

```sh
pnpm exec turbo run test --filter=@cloudroom/scripts --filter=@cloudroom/config --concurrency=2
```

Desktop integration tests open real apps, so run them only in a test environment. The sync and preview helpers in `apps/server/src/assets/` are copies from the core, so change them there.

The build makes runnable bundles, not a signed installer.
