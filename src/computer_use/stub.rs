//! Windows stub for computer use. The real desktop driver needs Xvfb, AT-SPI and
//! the pinned Cua Driver from `web/computer-use.sh`, all Linux-only.
use std::io;

pub const SKILL: &str = include_str!("SKILL.md");

pub async fn cli(_args: &[String]) -> Result<i32, io::Error> {
    Err(io::Error::other(
        "computer use requires a Unix platform on this build",
    ))
}
