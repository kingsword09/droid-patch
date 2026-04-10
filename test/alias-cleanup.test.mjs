import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

const IS_WINDOWS = platform() === "win32";

function buildPatches() {
  return {
    isCustom: true,
    skipLogin: false,
    apiBase: null,
    websearch: false,
    reasoningEffort: false,
  };
}

async function importFresh(modulePath) {
  const url = new URL(`../src/${modulePath}?t=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href);
}

async function withTempHome(run) {
  const homeDir = await mkdtemp(join(tmpdir(), "droid-patch-alias-cleanup-"));
  const binDir = join(homeDir, "bin");
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;

  await mkdir(binDir, { recursive: true });

  process.env.HOME = homeDir;
  process.env.PATH = binDir;

  try {
    await run(homeDir, binDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }

    await rm(homeDir, { recursive: true, force: true });
  }
}

void test(
  "clearAllMetadata removes every metadata file in the current HOME",
  { concurrency: false },
  async () => {
    await withTempHome(async (homeDir) => {
      const metadata = await importFresh("metadata.ts");

      await metadata.saveAliasMetadata(
        metadata.createMetadata("ghost-a", "/tmp/droid", buildPatches()),
      );
      await metadata.saveAliasMetadata(
        metadata.createMetadata("ghost-b", "/tmp/droid", buildPatches()),
      );

      assert.equal((await metadata.listAllMetadata()).length, 2);
      assert.equal(await metadata.clearAllMetadata(), 2);
      assert.equal((await metadata.listAllMetadata()).length, 0);

      await assert.rejects(lstat(join(homeDir, ".droid-patch", "meta", "ghost-a.json")));
      await assert.rejects(lstat(join(homeDir, ".droid-patch", "meta", "ghost-b.json")));
    });
  },
);

void test(
  "list marks broken aliases as stale and removeAlias deletes the broken symlink plus metadata",
  { concurrency: false, skip: IS_WINDOWS },
  async () => {
    await withTempHome(async (homeDir, binDir) => {
      const aliasName = `ghost-${Date.now()}`;
      const aliasPath = join(binDir, aliasName);
      const proxyDir = join(homeDir, ".droid-patch", "proxy");
      const proxyTarget = join(proxyDir, aliasName);

      await mkdir(proxyDir, { recursive: true });
      await symlink(proxyTarget, aliasPath);
      await lstat(aliasPath);

      const metadata = await importFresh("metadata.ts");
      const aliasModule = await importFresh("alias.ts");

      await metadata.saveAliasMetadata(
        metadata.createMetadata(aliasName, "/tmp/droid", buildPatches(), { aliasPath }),
      );

      let output = "";
      const originalLog = console.log;
      console.log = (...args) => {
        output += `${args.join(" ")}\n`;
      };

      try {
        await aliasModule.listAliases();
      } finally {
        console.log = originalLog;
      }

      assert.match(output, new RegExp(`${aliasName}[\\s\\S]*stale broken symlink`));
      assert.match(output, new RegExp(`${aliasName}[\\s\\S]*Target missing; run`));

      await aliasModule.removeAlias(aliasName);

      await assert.rejects(lstat(aliasPath));
      await assert.rejects(lstat(join(homeDir, ".droid-patch", "meta", `${aliasName}.json`)));
    });
  },
);
