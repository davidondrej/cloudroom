export const DRIVER = {
  version: "0.35.2",
  releaseUrl: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.2",
  macTeamId: "YCK386LBJ7",
  assets: {
    darwin: {
      file: "cua-driver-rs-0.35.2-darwin-universal-binary.tar.gz",
      sha256: "ec8d9a073ee8c5e81113de682ba17b040eaacd58e84139f851540092c6b8d3b6",
    },
    "linux-x64": {
      file: "cua-driver-rs-0.35.2-linux-x86_64-binary.tar.gz",
      sha256: "3a47b35ae8e083af8975c62f873a142f4a47c248c630a0eebfdf90de14d6fccf",
    },
    "linux-arm64": {
      file: "cua-driver-rs-0.35.2-linux-arm64-binary.tar.gz",
      sha256: "484d5c5cffa9c32d09244d4dfee078a1c4e8a175e1173f9129ec3bd113e45deb",
    },
  },
} as const;

export function assetFor(platform: string, arch: string) {
  if (platform === "darwin") return DRIVER.assets.darwin;
  if (platform === "linux" && arch === "x64") return DRIVER.assets["linux-x64"];
  if (platform === "linux" && arch === "arm64") return DRIVER.assets["linux-arm64"];
  return null;
}

export const SESSION_TOOLS = new Set([
  "browser_click", "browser_dialog", "browser_download", "browser_navigate", "browser_pointer",
  "browser_prepare", "browser_set_input_files", "browser_type", "click", "clipboard_read",
  "clipboard_write", "double_click", "drag", "end_session", "get_agent_cursor_state",
  "get_browser_state", "get_cursor_position", "get_desktop_state", "get_screen_size", "get_session",
  "get_window_state", "hotkey", "invoke_menu", "move_cursor", "press_key", "right_click", "scroll",
  "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme", "set_value",
  "set_window_frame", "start_recording", "start_session", "type_text", "verify_state",
]);

export const PID_REQUIRED_TOOLS = new Set([
  "click", "double_click", "right_click", "drag", "hotkey", "press_key", "scroll", "type_text",
  "set_value", "get_window_state", "invoke_menu", "verify_state", "set_window_frame",
  "bring_to_front", "kill_app",
]);

// run_script and run_steps can target apps by name inside one call, which would skip the per-app approval.
export const BLOCKED_TOOLS = new Set([
  "set_config", "install_extension", "install_ffmpeg", "check_for_update", "replay_trajectory",
  "run_script", "run_steps",
]);

export const LIME_CURSOR_SUFFIX = "-8";

export const WHOLE_SCREEN = { key: "whole-screen", name: "the whole screen" } as const;
