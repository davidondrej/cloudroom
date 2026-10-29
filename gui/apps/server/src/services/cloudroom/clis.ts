import { findCliExecutable } from "@cloudroom/process-utils";

/** A CLI this Mac has, with the setup-script lines that install its Linux version in a cloud sandbox. */
export interface MacCli { name: string; title: string; key?: string; install: string }

// Every line was tested as the agent on a fresh sandbox (Debian 12, arm64, no gpg) on 2026-10-14. `command -v` skips
// the install when the setup script runs again. A CLI still missing after its install prints `setup-failed: NAME`, so
// the setup runner (web/lib/sandbox-logins.ts) tries again on the next wake.
const apt = (pkg: string) => `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkg}`;
const npm = (pkg: string) => `sudo npm install -g --silent ${pkg}`;
const aptRepo = (name: string, key: string, source: string, pkg: string) => `{
  sudo curl -fsSL ${key} -o /usr/share/keyrings/${name}.asc
  echo "deb [signed-by=/usr/share/keyrings/${name}.asc] ${source}" | sudo tee /etc/apt/sources.list.d/${name}.list >/dev/null
  ${apt(pkg)}
}`;
const download = (bin: string, url: string) => `{ sudo curl -fsSL "${url}" -o /usr/local/bin/${bin} && sudo chmod +x /usr/local/bin/${bin}; }`;
const ARCH = "$(dpkg --print-architecture)";

const CLIS: (Omit<MacCli, "install"> & { run: string })[] = [
  { name: "op", title: "1Password CLI", key: "OP_SERVICE_ACCOUNT_TOKEN", run: aptRepo("1password", "https://downloads.1password.com/linux/keys/1password.asc", `https://downloads.1password.com/linux/debian/${ARCH} stable main`, "1password-cli") },
  { name: "stripe", title: "Stripe CLI", key: "STRIPE_API_KEY", run: aptRepo("stripe", "https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public", "https://packages.stripe.dev/stripe-cli-debian-local stable main", "stripe") },
  { name: "terraform", title: "Terraform", run: aptRepo("hashicorp", "https://apt.releases.hashicorp.com/gpg", `https://apt.releases.hashicorp.com $(. /etc/os-release && echo "$VERSION_CODENAME") main`, "terraform") },
  { name: "vercel", title: "Vercel CLI", key: "VERCEL_TOKEN", run: npm("vercel") },
  { name: "wrangler", title: "Cloudflare Wrangler", key: "CLOUDFLARE_API_TOKEN", run: npm("wrangler") },
  { name: "netlify", title: "Netlify CLI", key: "NETLIFY_AUTH_TOKEN", run: npm("netlify-cli") },
  { name: "railway", title: "Railway CLI", key: "RAILWAY_API_TOKEN", run: npm("@railway/cli") },
  { name: "firebase", title: "Firebase CLI", run: npm("firebase-tools") },
  { name: "neonctl", title: "Neon CLI", key: "NEON_API_KEY", run: npm("neonctl") },
  { name: "heroku", title: "Heroku CLI", key: "HEROKU_API_KEY", run: npm("heroku") },
  { name: "supabase", title: "Supabase CLI", key: "SUPABASE_ACCESS_TOKEN", run: `curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${ARCH}.tar.gz" | sudo tar -xz -C /usr/local/bin supabase` },
  { name: "flyctl", title: "Fly.io CLI", key: "FLY_API_TOKEN", run: "curl -fsSL https://fly.io/install.sh | sudo FLYCTL_INSTALL=/usr/local sh" },
  { name: "doppler", title: "Doppler CLI", key: "DOPPLER_TOKEN", run: "curl -fsSL https://cli.doppler.com/install.sh | sudo sh" },
  { name: "aws", title: "AWS CLI", key: "AWS_ACCESS_KEY_ID", run: `{ curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/aws.zip && unzip -qo /tmp/aws.zip -d /tmp && sudo /tmp/aws/install; rm -rf /tmp/aws /tmp/aws.zip; }` },
  { name: "kubectl", title: "kubectl", run: `{ curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" && sudo install /tmp/kubectl /usr/local/bin/kubectl; rm -f /tmp/kubectl; }` },
  { name: "cloudflared", title: "Cloudflare Tunnel", run: download("cloudflared", `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`) },
  { name: "yt-dlp", title: "yt-dlp", run: download("yt-dlp", "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp") },
  { name: "uv", title: "uv", run: "curl -LsSf https://astral.sh/uv/install.sh | sh" },
  { name: "mise", title: "mise", run: "curl -fsSL https://mise.run | sh" },
  { name: "hf", title: "Hugging Face CLI", key: "HF_TOKEN", run: "{ command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh; ~/.local/bin/uv tool install -q huggingface_hub; }" },
  { name: "deno", title: "Deno", run: "curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh -s -- -y --no-modify-path" },
  { name: "go", title: "Go", run: `{ curl -fsSL "https://go.dev/dl/$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1).linux-${ARCH}.tar.gz" | sudo tar -xz -C /usr/local && sudo ln -sf /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/; }` },
  { name: "cargo", title: "Rust", run: "{ curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path && ln -sf ~/.cargo/bin/* ~/.local/bin/; }" },
  { name: "ffmpeg", title: "FFmpeg", run: `{ ${apt("ffmpeg")}; }` },
  { name: "pandoc", title: "Pandoc", run: `{ ${apt("pandoc")}; }` },
  { name: "psql", title: "PostgreSQL client", run: `{ ${apt("postgresql-client")}; }` },
  { name: "redis-cli", title: "Redis CLI", run: `{ ${apt("redis-tools")}; }` },
  { name: "sqlite3", title: "SQLite", run: `{ ${apt("sqlite3")}; }` },
  { name: "rg", title: "ripgrep", run: `{ ${apt("ripgrep")}; }` },
];

/** The catalog CLIs found on this Mac. The app adds `install` to the setup script as-is, so keep each block stable. */
export function macClis(): MacCli[] {
  return CLIS.filter(cli => findCliExecutable(cli.name)).map(({ run, ...cli }) => ({
    ...cli,
    install: `# ${cli.title} (${cli.name})${cli.key ? `. Signs in with ${cli.key} from API keys.` : ""}\ncommand -v ${cli.name} >/dev/null || ${run}\ncommand -v ${cli.name} >/dev/null || echo "setup-failed: ${cli.name}"`,
  }));
}
