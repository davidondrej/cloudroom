export const DRIVER = {
  version: "0.55.0",
  releaseUrl: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.55.0",
  macTeamId: "YCK386LBJ7",
  assets: {
    darwin: {
      file: "cua-driver-rs-0.55.0-darwin-universal-binary.tar.gz",
      sha256: "e6246d3da20abe019e2660e8b5f77e0c12cf9b386597a76393116994a36db6ce",
    },
    "linux-x64": {
      file: "cua-driver-rs-0.55.0-linux-x86_64-binary.tar.gz",
      sha256: "1cb8aa6d30e5cdf5bf4d222cb3693a50af2c178073a49dc59e88737c5f7807e6",
    },
    "linux-arm64": {
      file: "cua-driver-rs-0.55.0-linux-arm64-binary.tar.gz",
      sha256: "401f7f4a9ad276dbcdb324f1b00e152987a46985b68c9e625ac01101f5e6af77",
    },
  },
} as const;

export function assetFor(platform: string, arch: string) {
  if (platform === "darwin") return DRIVER.assets.darwin;
  if (platform === "linux" && arch === "x64") return DRIVER.assets["linux-x64"];
  if (platform === "linux" && arch === "arm64") return DRIVER.assets["linux-arm64"];
  return null;
}

// The driver lets kill_app stop only apps launch_app started in the same session (#1950).
export const SESSION_TOOLS = new Set([
  "browser_click", "browser_dialog", "browser_download", "browser_motion_policy",
  "browser_navigate", "browser_pointer", "browser_prepare", "browser_select",
  "browser_set_input_files", "browser_type", "click", "clipboard_read",
  "clipboard_write", "double_click", "drag", "end_session", "get_agent_cursor_state",
  "get_browser_state", "get_cursor_position", "get_desktop_state", "get_guide",
  "get_screen_size", "get_session", "get_window_state", "hotkey", "invoke_menu",
  "kill_app", "launch_app", "move_cursor", "press_key", "right_click", "scroll",
  "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme",
  "set_value", "set_window_frame", "start_recording", "start_session",
  "type_text", "verify_state",
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
export const CLIPBOARD = { key: "clipboard", name: "the clipboard" } as const;
