// Stamp the git commit into the binary so every VM reports its exact build (ADR 0120).
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    let text = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !text.is_empty()).then_some(text)
}

fn main() {
    // Source snapshots without git history build as "unknown".
    let commit = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=CLOUDROOM_COMMIT={commit}");
    println!("cargo:rerun-if-changed=build.rs");
    // Rebuild the stamp when HEAD moves, including in worktrees and after `git gc`.
    let branch = git(&["symbolic-ref", "-q", "HEAD"]);
    for path in ["HEAD", "packed-refs"]
        .into_iter()
        .map(str::to_owned)
        .chain(branch)
    {
        if let Some(file) = git(&["rev-parse", "--path-format=absolute", "--git-path", &path]) {
            println!("cargo:rerun-if-changed={file}");
        }
    }
}
