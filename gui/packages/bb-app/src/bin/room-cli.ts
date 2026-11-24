#!/usr/bin/env node
import { runRoomCli } from "../host.js";
import { runLauncherEntry } from "../start.js";

runLauncherEntry(runRoomCli);
