//! `cloudroom git` on real throwaway repositories: the JSON the app's Git panel and diff view read.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

struct Repo(PathBuf);

/// Git with no user or system settings, so every machine sees the same thing.
fn git_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.com")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.com");
    command
}

impl Repo {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("cloudroom-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let repo = Self(dir);
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        let output = git_command("git")
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn write(&self, path: &str, contents: impl AsRef<[u8]>) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", message]);
    }

    fn run(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = git_command(env!("CARGO_BIN_EXE_cloudroom"))
            .arg("git")
            .args(args)
            .current_dir(&self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }

    fn json(&self, args: &[&str]) -> Value {
        self.json_in(args, "")
    }

    fn json_in(&self, args: &[&str], stdin: &str) -> Value {
        let output = self.run(args, stdin);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn code(&self, args: &[&str]) -> i32 {
        self.run(args, "").status.code().unwrap()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `path status insertions deletions` for each file, in order.
fn summary(files: &Value) -> Vec<String> {
    files
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            format!(
                "{} {} {} {}",
                file["path"].as_str().unwrap(),
                file["status"],
                file["insertions"],
                file["deletions"]
            )
        })
        .collect()
}

#[test]
fn errors_have_their_exit_codes() {
    let outside =
        std::env::temp_dir().join(format!("cloudroom-git-outside-{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_cloudroom"))
        .args(["git", "status"])
        .current_dir(&outside)
        .env("GIT_CEILING_DIRECTORIES", std::env::temp_dir())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let repo = Repo::new("errors");
    repo.write("a.txt", "a\n");
    repo.commit("one");
    assert_eq!(repo.code(&["files", "branch:nope"]), 5);
    assert_eq!(repo.code(&["files", "commit:deadbeef"]), 5);
    assert_eq!(repo.code(&["files", "branch:--output=x"]), 2);
    assert_eq!(
        repo.code(&["show", "uncommitted", "new", "../etc/passwd"]),
        2
    );
    assert_eq!(repo.code(&["show", "uncommitted", "new", "missing.txt"]), 6);
    assert_eq!(repo.code(&["commit", "--message", "nothing"]), 4);
}

#[test]
fn status_counts_lines_and_names_every_kind_of_change() {
    let repo = Repo::new("status");
    // A fresh repository: no commit yet.
    repo.write("first.txt", "1\n2\n");
    let status = repo.json(&["status"]);
    assert_eq!(
        status["checkout"],
        json!({ "kind": "unborn", "branchName": "main" })
    );
    assert_eq!(
        summary(&status["workingTree"]["files"]),
        ["first.txt \"??\" 2 0"]
    );
    assert_eq!(status["workingTree"]["state"], "untracked");

    repo.write("keep.txt", "a\nb\nc\n");
    repo.write("old name.txt", "same\nlines\nhere\n");
    repo.write("gone.txt", "x\n");
    repo.commit("one");
    repo.write("keep.txt", "a\nB\nc\nd\n");
    // Windows file names can't hold a line break.
    let renamed = if cfg!(unix) {
        "new\nname ü.txt"
    } else {
        "new name ü.txt"
    };
    repo.git(&["mv", "old name.txt", renamed]);
    fs::remove_file(repo.0.join("gone.txt")).unwrap();
    repo.write("new.txt", "n\n");
    repo.write("big.bin", vec![b'x'; 1024 * 1024 + 1]);
    let status = repo.json(&["status"]);
    let tree = &status["workingTree"];
    assert_eq!(
        summary(&tree["files"]),
        [
            "gone.txt \"D\" 0 1",
            "keep.txt \"M\" 2 1",
            &format!("{renamed} \"R\" 0 0"),
            "big.bin \"??\" null null",
            "new.txt \"??\" 1 0",
        ]
    );
    assert_eq!(
        (tree["insertions"].as_u64(), tree["deletions"].as_u64()),
        (Some(3), Some(2))
    );
    assert_eq!(
        tree["lineStatsComplete"], false,
        "the big file is never read"
    );
    assert_eq!(tree["state"], "dirty_uncommitted");
    assert_eq!(
        status["branch"],
        json!({ "currentBranch": "main", "defaultBranch": "main" })
    );
    assert_eq!(status["mergeBase"], Value::Null);

    repo.commit("two");
    let head = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["checkout", "-q", "--detach"]);
    let status = repo.json(&["status"]);
    assert_eq!(
        status["checkout"],
        json!({ "kind": "detached", "headSha": head })
    );
    assert_eq!(status["workingTree"]["state"], "clean");
}

#[test]
fn reads_never_change_the_repository() {
    let repo = Repo::new("read-only");
    repo.write("a.txt", "a\n");
    repo.commit("one");
    repo.write("a.txt", "b\n");
    repo.write("untracked.txt", "u\n");
    let index = fs::read(repo.0.join(".git/index")).unwrap();
    let objects = repo.git(&["count-objects", "-v"]);
    repo.json(&["status"]);
    repo.json(&["files", "uncommitted"]);
    repo.json_in(&["patch", "uncommitted"], "untracked.txt\0");
    repo.json(&["diff", "uncommitted"]);
    assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), index);
    assert_eq!(repo.git(&["count-objects", "-v"]), objects);
    assert!(
        repo.git(&["status", "--porcelain"])
            .contains("?? untracked.txt")
    );

    // A file saved again unchanged leaves the index's saved file times stale; Git must not rewrite the index for it.
    fs::remove_file(repo.0.join("untracked.txt")).unwrap();
    repo.commit("two");
    let index = fs::read(repo.0.join(".git/index")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    repo.write("a.txt", "b\n");
    for args in [
        &["status"][..],
        &["files", "uncommitted"],
        &["diff", "uncommitted"],
    ] {
        repo.json(args);
        assert_eq!(
            fs::read(repo.0.join(".git/index")).unwrap(),
            index,
            "{args:?}"
        );
    }
}

#[test]
fn a_branch_compares_against_its_base() {
    let repo = Repo::new("branch");
    repo.write("base.txt", "base\n");
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("feature.txt", "one\ntwo\n");
    repo.commit("Add feature");
    repo.git(&["checkout", "-q", "main"]);
    repo.write("main.txt", "m\n");
    repo.commit("Main moves on");
    repo.git(&["checkout", "-q", "feature"]);

    let status = repo.json(&["status", "--base", "main"]);
    assert_eq!(
        repo.json(&["status", "--default-base"])["mergeBase"],
        status["mergeBase"]
    );
    let merge_base = &status["mergeBase"];
    assert_eq!(
        (
            merge_base["aheadCount"].as_u64(),
            merge_base["behindCount"].as_u64()
        ),
        (Some(1), Some(1))
    );
    assert_eq!(merge_base["commits"][0]["subject"], "Add feature");
    assert_eq!(summary(&merge_base["files"]), ["feature.txt \"A\" 2 0"]);
    assert_eq!(status["workingTree"]["state"], "committed_unmerged");

    let files = repo.json(&["files", "branch:main"]);
    assert_eq!(files["files"][0]["path"], "feature.txt");
    assert_eq!(files["shortstat"], "1 file changed, 2 insertions(+)\n");
    assert_eq!(files["mergeBaseRef"], merge_base["baseRef"]);
    assert_eq!(repo.code(&["files", "branch:main"]), 0);

    // Squash-merged into main: nothing left to merge.
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["merge", "-q", "--squash", "feature"]);
    repo.commit("Squashed feature");
    repo.git(&["checkout", "-q", "feature"]);
    let merge_base = &repo.json(&["status", "--base", "main"])["mergeBase"];
    assert_eq!(merge_base["aheadCount"], 0);
    assert_eq!(merge_base["commits"], json!([]));
    assert_eq!(merge_base["hasCommittedUnmergedChanges"], false);
}

#[test]
fn files_and_patches_cover_renames_untracked_and_binary_files() {
    let repo = Repo::new("files");
    repo.write("moved.txt", "1\n2\n3\n4\n5\n");
    repo.write("image.png", [0u8, 1, 2, 3]);
    repo.commit("one");
    fs::create_dir(repo.0.join("dir")).unwrap();
    repo.git(&["mv", "moved.txt", "dir/moved.txt"]);
    repo.write("image.png", [0u8, 9, 9, 3]);
    repo.write("new.txt", "fresh\n");
    repo.write("huge.log", vec![b'x'; 1024 * 1024 + 1]);
    let files = repo.json(&["files", "uncommitted"]);
    let rows: Vec<String> = files["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            format!(
                "{} {} {} {} {} {}",
                file["path"],
                file["previousPath"],
                file["statusLetter"],
                file["additions"],
                file["binary"],
                file["origin"]
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            "\"dir/moved.txt\" \"moved.txt\" \"R\" 0 false \"tracked\"",
            "\"image.png\" null \"M\" 0 true \"tracked\"",
            "\"new.txt\" null \"A\" 1 false \"untracked\"",
            "\"huge.log\" null \"A\" 0 true \"untracked\"",
        ]
    );
    assert_eq!(
        repo.json(&["files", "uncommitted", "--max-files", "2"])["truncated"],
        true
    );

    let patches = repo.json_in(
        &["patch", "uncommitted", "--max-bytes", "60"],
        "dir/moved.txt\0new.txt\0new.txt\0",
    );
    let patches = patches.as_array().unwrap();
    assert_eq!(patches.len(), 2, "duplicates are dropped");
    assert_eq!(patches[1]["truncated"], true);
    let full = repo.json_in(&["patch", "uncommitted"], "dir/moved.txt\0new.txt\0");
    assert!(
        full[0]["patch"]
            .as_str()
            .unwrap()
            .contains("rename from moved.txt"),
        "{}",
        full[0]
    );
    assert!(
        full[1]["patch"].as_str().unwrap().ends_with("+fresh\n"),
        "{}",
        full[1]
    );

    assert_eq!(
        repo.json_in(&["patch", "uncommitted"], "huge.log\0")[0]["truncated"],
        true,
        "too big to read"
    );

    let diff = repo.json(&["diff", "uncommitted"]);
    assert!(diff["diff"].as_str().unwrap().contains("+fresh"));
    let list = diff["files"].as_str().unwrap();
    assert!(list.contains("R100\tmoved.txt\tdir/moved.txt"), "{list}");
    assert!(list.contains("A\thuge.log"), "{list}");
    assert_eq!(diff["truncated"], true, "huge.log's lines are missing");
}

#[test]
fn untracked_files_outside_a_sparse_checkout_count() {
    let repo = Repo::new("sparse");
    repo.write("in/a.txt", "a\n");
    repo.write("out/b.txt", "b\n");
    repo.commit("one");
    repo.git(&["sparse-checkout", "set", "in"]);
    repo.write("out/new.txt", "n\n");
    let status = repo.json(&["status"]);
    assert_eq!(
        summary(&status["workingTree"]["files"]),
        ["out/new.txt \"??\" 1 0"]
    );
    assert_eq!(
        repo.json(&["files", "uncommitted"])["files"][0]["path"],
        "out/new.txt"
    );
}

#[test]
fn show_reads_either_side_inside_the_checkout_only() {
    let repo = Repo::new("show");
    repo.write("a.txt", "old\n");
    repo.commit("one");
    repo.write("a.txt", "new\n");
    let show = |side| {
        String::from_utf8(repo.run(&["show", "uncommitted", side, "a.txt"], "").stdout).unwrap()
    };
    assert_eq!(
        (show("old"), show("new")),
        ("old\n".to_owned(), "new\n".to_owned())
    );
    let commit = repo.git(&["rev-parse", "HEAD"]);
    assert_eq!(
        repo.run(&["show", &format!("commit:{commit}"), "new", "a.txt"], "")
            .stdout,
        b"old\n"
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/hosts", repo.0.join("outside")).unwrap();
        assert_eq!(repo.code(&["show", "uncommitted", "new", "outside"]), 6);
    }
}

#[test]
fn branches_put_the_default_first() {
    let repo = Repo::new("branches");
    repo.write("a.txt", "a\n");
    repo.commit("one");
    repo.git(&["branch", "alpha"]);
    repo.git(&["branch", "beta"]);
    let branches = repo.json(&["branches", "--limit", "2", "--selected", "gamma"]);
    assert_eq!(branches["branches"], json!(["main", "alpha"]));
    assert_eq!(branches["branchesTruncated"], true);
    assert_eq!(
        branches["selectedBranch"],
        json!({ "name": "gamma", "kind": "missing" })
    );
    assert_eq!(
        repo.json(&["branches", "--query", "BET"])["branches"],
        json!(["beta"])
    );
}

#[test]
fn commit_takes_every_change() {
    let repo = Repo::new("commit");
    repo.write("a.txt", "a\n");
    repo.commit("one");
    repo.write("b.txt", "b\n");
    let commit = repo.json(&["commit", "--message", "Add b"]);
    assert_eq!(commit["commitSubject"], "Add b");
    assert_eq!(commit["commitSha"], repo.git(&["rev-parse", "HEAD"]));
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}
