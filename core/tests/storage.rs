use cloudroom::workspace::storage::Policy;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn storage_requires_protected_explicit_policy() {
    let path = std::env::temp_dir().join(format!(
        "cloudroom-policy-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&path, r#"{"agent_uid":1001,"agent_gid":1001,"cache_dir":"/var/cache/cloudroom-agent","cgroup_root":"/sys/fs/cgroup/example/agents"}"#).unwrap();
    // /tmp is writable by agents: a policy placed here cannot establish trusted identities.
    assert!(Policy::load(&path).is_err());
    fs::remove_file(path).unwrap();
}
