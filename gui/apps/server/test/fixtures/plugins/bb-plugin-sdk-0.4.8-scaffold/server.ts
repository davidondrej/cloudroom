import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(room: BbPluginApi) {
  room.log.info("0.4.8 scaffold upgrade fixture loaded");
}
