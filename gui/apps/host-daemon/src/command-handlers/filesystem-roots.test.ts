import { describe, expect, it } from "vitest";
import {
  isNetworkDriveReachable,
  listFilesystemRoots,
} from "./filesystem-roots.js";

describe("listFilesystemRoots", () => {
  it("returns the single POSIX root without probing", async () => {
    await expect(
      listFilesystemRoots({
        platform: "darwin",
        isDirectory: () => Promise.reject(new Error("should not probe")),
      }),
    ).resolves.toEqual(["/"]);
  });

  it("lists every accessible Windows drive, not just the current one", async () => {
    const mounted = new Set(["C:\\", "G:\\", "H:\\"]);

    await expect(
      listFilesystemRoots({
        platform: "win32",
        readDriveTypes: async () => null,
        probeInChildProcess: async (roots) =>
          new Set(roots.filter((root) => mounted.has(root))),
      }),
    ).resolves.toEqual(["C:\\", "G:\\", "H:\\"]);
  });

  it("omits drives whose probe fails or never settles", async () => {
    await expect(
      listFilesystemRoots({
        platform: "win32",
        readDriveTypes: async () =>
          new Map(["C:\\", "D:\\", "Z:\\"].map((root) => [root, "Fixed"])),
        probeTimeoutMs: 10,
        isDirectory: (root) => {
          if (root === "C:\\") return Promise.resolve(true);
          if (root === "D:\\") return Promise.reject(new Error("EPERM"));
          if (root === "Z:\\") return new Promise<boolean>(() => {});
          return Promise.resolve(false);
        },
      }),
    ).resolves.toEqual(["C:\\"]);
  });

  it("never starts a second probe on a drive whose probe is still running", async () => {
    const pendingProbes = new Map<string, Promise<boolean>>();
    let releaseHungDrive: (mounted: boolean) => void = () => {};
    const hungDrive = new Promise<boolean>((resolve) => {
      releaseHungDrive = resolve;
    });
    const probes: string[] = [];
    const list = () =>
      listFilesystemRoots({
        platform: "win32",
        readDriveTypes: async () =>
          new Map([
            ["C:\\", "Fixed"],
            ["Z:\\", "Fixed"],
          ]),
        probeTimeoutMs: 10,
        pendingProbes,
        isDirectory: (root) => {
          probes.push(root);
          if (root === "C:\\") return Promise.resolve(true);
          if (root === "Z:\\") return hungDrive;
          return Promise.resolve(false);
        },
      });

    for (let browse = 0; browse < 3; browse += 1) {
      await expect(list()).resolves.toEqual(["C:\\"]);
    }
    expect(probes.filter((root) => root === "Z:\\")).toHaveLength(1);
    expect(probes.filter((root) => root === "C:\\")).toHaveLength(3);

    releaseHungDrive(true);
    await expect(list()).resolves.toEqual(["C:\\", "Z:\\"]);
    await list();
    expect(probes.filter((root) => root === "Z:\\")).toHaveLength(2);
  });

  it("lists network drives by letter without probing them, and skips missing letters", async () => {
    const probes: string[] = [];
    await expect(
      listFilesystemRoots({
        platform: "win32",
        readDriveTypes: async () =>
          new Map([
            ["C:\\", "Fixed"],
            ["E:\\", "Removable"],
            ["F:\\", "CDRom"],
            ["Y:\\", "NoRootDirectory"],
            ["Z:\\", "Network"],
          ]),
        isDirectory: async (root) => {
          probes.push(root);
          return root !== "F:\\";
        },
      }),
    ).resolves.toEqual(["C:\\", "E:\\", "Z:\\"]);
    expect(probes).toEqual(["C:\\", "E:\\", "F:\\"]);
  });

  it("probes a network drive in a killable child before browsing it, and only a network drive", async () => {
    const types = async () =>
      new Map([
        ["C:\\", "Fixed"],
        ["Z:\\", "Network"],
      ]);
    const probes: string[] = [];
    const hung = async (roots: string[]) => {
      probes.push(...roots);
      return new Set<string>();
    };
    await expect(isNetworkDriveReachable("C:\\src", types, hung)).resolves.toBe(true);
    await expect(isNetworkDriveReachable("/home/me", types, hung)).resolves.toBe(true);
    await expect(isNetworkDriveReachable("z:\\share\\repo", types, hung)).resolves.toBe(false);
    expect(probes.filter((root) => root !== "Z:\\")).toEqual([]);
  }, 5_000);
});

