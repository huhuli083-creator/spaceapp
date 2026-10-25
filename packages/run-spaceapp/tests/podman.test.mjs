import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import test from "node:test";

import {
  composeCommand,
  createDefaultConfig,
  loadConfig,
  prepareInstallation,
  renderWorkspaceCompose,
  resolveInstallEngine,
  saveConfig,
  userSlug,
  validateConfig
} from "../src/index.mjs";
import {
  detectContainerEngine,
  ensureDockerAvailable,
  ensurePodmanAvailable
} from "../src/prerequisites.mjs";
import {
  inspectStoragePlan
} from "../src/storage.mjs";
import { run } from "../src/cli.mjs";

function ttyStdin(...answers) {
  let index = 0;
  let eventMode = false;
  const dataHandlers = [];
  const endHandlers = [];
  const keypressHandlers = [];
  const stream = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on(event, handler) {
      if (event === "data") {
        dataHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      } else if (event === "end") {
        endHandlers.push(handler);
      } else if (event === "keypress") {
        keypressHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      }
      return stream;
    },
    once(event, handler) {
      if (event === "data" || event === "end" || event === "keypress") {
        stream.on(event, handler);
      }
      return stream;
    },
    removeListener() { return stream; },
    off() { return stream; },
    listenerCount(event) {
      if (event === "data") return dataHandlers.length;
      if (event === "end") return endHandlers.length;
      if (event === "keypress") return keypressHandlers.length;
      return 0;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) return { done: true };
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() { return { done: true }; }
      };
    }
  };
  function deliverEvents() {
    while (index < answers.length) {
      const answer = answers[index];
      index += 1;
      if (keypressHandlers.length > 0) {
        for (const character of answer) {
          for (const handler of [...keypressHandlers]) {
            handler({ sequence: character, name: undefined, ctrl: false, meta: false, shift: false });
          }
        }
        for (const handler of [...keypressHandlers]) {
          handler({ sequence: "\r", name: "return", ctrl: false, meta: false, shift: false });
        }
      } else {
        for (const handler of [...dataHandlers]) {
          handler(`${answer}\n`);
        }
      }
    }
    for (const handler of [...endHandlers]) handler();
  }
  return stream;
}

function createIo() {
  let out = "";
  let err = "";
  return {
    stdin: { isTTY: false },
    stdout: { write(chunk) { out += String(chunk); } },
    stderr: { write(chunk) { err += String(chunk); } },
    get stdoutText() { return out; },
    get stderrText() { return err; }
  };
}

test("resolveInstallEngine accepts docker and podman and defaults to docker", () => {
  assert.equal(resolveInstallEngine(undefined), "docker");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine("docker"), "docker");
  assert.equal(resolveInstallEngine("podman"), "podman");
  assert.throws(() => resolveInstallEngine("containerd"), /Install engine must be docker or podman/);
});

test("detectContainerEngine prefers explicit flag, then docker, then podman", async () => {
  const podmanOnlyExec = async (spec) => (spec.command === "podman" ? 0 : 127);
  assert.equal(await detectContainerEngine({ execute: podmanOnlyExec }), "podman");
  assert.equal(await detectContainerEngine({ execute: podmanOnlyExec, requestedEngine: "docker" }), "docker");

  const bothExec = async () => 0;
  assert.equal(await detectContainerEngine({ execute: bothExec }), "docker");
  assert.equal(await detectContainerEngine({ execute: bothExec, requestedEngine: "podman" }), "podman");
});

test("composeCommand uses podman when engine is podman across lifecycle actions", () => {
  for (const action of ["up", "down", "status", "logs", "pull", "backup", "purge"]) {
    const spec = composeCommand(action, "/tmp/spaceapp-podman", {
      profile: "light",
      engine: "podman"
    });
    assert.equal(spec.command, "podman");
    assert.equal(spec.args[0], "compose");
  }
});

test("validateConfig rejects host-root access mode when engine is podman", () => {
  const validPodman = createDefaultConfig({
    version: "1.1.12",
    profile: "light",
    accessMode: "isolated",
    engine: "podman"
  });
  assert.doesNotThrow(() => validateConfig(validPodman));

  assert.throws(
    () =>
      validateConfig({
        ...validPodman,
        accessMode: "host-root"
      }),
    /Host-root access is not supported on Podman\. Use --access isolated\./
  );
});

test("renderWorkspaceCompose adds SELinux relabeling (:z) for podman bind mounts", () => {
  let config = createDefaultConfig({
    version: "1.1.12",
    profile: "light",
    accessMode: "isolated",
    engine: "podman"
  });
  config = {
    ...config,
    workspaces: [
      {
        id: "project-01234567",
        hostPath: "/home/user/project",
        containerPath: "/workspaces/project",
        readOnly: false
      }
    ]
  };
  const renderedPodman = renderWorkspaceCompose(config);
  assert.match(renderedPodman, /bind:\n\s+selinux: z/);
  assert.ok(renderedPodman.includes("./backups:/backups:z"));
  assert.ok(renderedPodman.includes("./secrets/providers:/run/spaceapp-secrets/providers:ro,z"));
  const renderedPodmanMultiUser = renderWorkspaceCompose({
    ...config,
    users: [{ id: "user:alice", workspaces: [] }]
  });
  assert.ok(renderedPodmanMultiUser.includes("./cli-hosts.json:/etc/spaceapp/cli-hosts.json:ro,z"));
  assert.ok(renderedPodmanMultiUser.includes(`./secrets/users/${userSlug("user:alice")}/providers:/run/spaceapp-secrets/providers:ro,z`));
  const renderedDocker = renderWorkspaceCompose({ ...config, engine: "docker" });
  assert.doesNotMatch(renderedDocker, /selinux: z/);
  assert.ok(!renderedDocker.includes(":ro,z"));
  });

test("prepareInstallation persists engine and refuses switching engines without backup/restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spaceapp-podman-prep-"));
  try {
    const prepared = await prepareInstallation(root, {
      version: "1.1.12",
      profile: "light",
      accessMode: "isolated",
      engine: "podman"
    });
    assert.equal(prepared.config.engine, "podman");
    await saveConfig(root, prepared.config);

    const loaded = await loadConfig(root);
    assert.equal(loaded.engine, "podman");

    await assert.rejects(
      () =>
        prepareInstallation(root, {
          version: "1.1.12",
          profile: "light",
          accessMode: "isolated",
          engine: "docker"
        }),
      /Cannot switch container engine from podman to docker on an existing installation/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensurePodmanAvailable verifies Podman >= 5, cgroup v2 on Linux, and machine readiness on macOS", async () => {
  const ioOk = createIo();
  const resOk = await ensureDockerAvailable({
    platform: "linux",
    stdout: ioOk.stdout,
    stderr: ioOk.stderr,
    installArgs: { engine: "podman" },
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args[0] === "info") {
        io.stdout?.write(JSON.stringify({
          version: { Version: "5.2.1" },
          host: { cgroupVersion: "v2", cpus: 4, memTotal: 8589934592 },
          store: { graphRoot: "/tmp" }
        }));
      }
      return 0;
    }
  });
  assert.equal(resOk.code, 0);
  assert.match(ioOk.stdoutText, /Podman engine is ready/);

  const ioOld = createIo();
  const resOld = await ensurePodmanAvailable({
    platform: "linux",
    stdout: ioOld.stdout,
    stderr: ioOld.stderr,
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args[0] === "info") {
        io.stdout?.write(JSON.stringify({
          version: { Version: "4.9.3" },
          host: { cgroupVersion: "v2" }
        }));
      }
      return 0;
    }
  });
  assert.equal(resOld.code, 1);
  assert.match(ioOld.stderrText, /Podman >= 5 is required/);

  const ioMacStopped = createIo();
  const resMacStopped = await ensurePodmanAvailable({
    platform: "darwin",
    stdout: ioMacStopped.stdout,
    stderr: ioMacStopped.stderr,
    execute: async (spec) => (spec.args[0] === "info" ? 125 : 0)
  });
  assert.equal(resMacStopped.code, 125);
  assert.match(ioMacStopped.stderrText, /podman machine init && podman machine start/);
});

test("inspectStoragePlan queries podman info and podman image inspect when engine is podman", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spaceapp-podman-storage-"));
  try {
    const commands = [];
    const execute = async (spec, io) => {
      commands.push(`${spec.command} ${spec.args.join(" ")}`);
      if (spec.command === "podman" && spec.args[0] === "info") {
        io.stdout?.write(JSON.stringify({
          host: { cpus: 6, memTotal: 17179869184, arch: "amd64" },
          store: { graphRoot: root }
        }));
        return 0;
      }
      if (spec.command === "podman" && spec.args[0] === "image") {
        io.stdout?.write("sha256:" + "a".repeat(64) + "\n");
        return 0;
      }
      return 1;
    };

    const config = createDefaultConfig({
      version: "1.1.12",
      profile: "light",
      accessMode: "isolated",
      engine: "podman"
    });
    const plan = await inspectStoragePlan({
      root,
      config,
      existingConfig: null,
      resources: { cpuCount: 8, totalMemoryBytes: 17179869184, freeDiskBytes: 50 * 1024 ** 3 },
      execute,
      operation: "fresh"
    });
    assert.equal(plan.resources.engineCpuCount, 6);
    assert.equal(plan.resources.engineMemoryBytes, 17179869184);
    assert.equal(plan.missingImages.length, 0);
    assert.ok(commands.every((cmd) => cmd.startsWith("podman ")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli install --engine podman persists engine and runs lifecycle commands with podman", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spaceapp-podman-cli-"));
  try {
    const executed = [];
    const execute = async (spec, io) => {
      executed.push(`${spec.command} ${(spec.args || []).join(" ")}`);
      if (spec.command === "podman" && spec.args?.[0] === "info") {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.3.0" },
          host: { cgroupVersion: "v2", cpus: 8, memTotal: 17179869184 },
          store: { graphRoot: root }
        }));
      }
      return 0;
    };

    const ioInstall = createIo();
    const code = await run(["install", "--engine", "podman", "--profile", "light", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdin: ttyStdin("", "", "", "", "", "y"),
      stdout: ioInstall.stdout,
      stderr: ioInstall.stderr,
      execute,
      prepareDockerPath: async () => null,
      inspectResources: async () => ({
        cpuCount: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 50 * 1024 ** 3
      }),
      request: async (url) => {
        if (url.endsWith("/readyz")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ setupRequired: true, expiresAt: "2099-01-01T00:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    assert.equal(code, 0, `STDERR: ${ioInstall.stderrText}\nSTDOUT: ${ioInstall.stdoutText}`);

    const saved = await loadConfig(root);
    assert.equal(saved.engine, "podman");
    assert.match(ioInstall.stdoutText, /PASS Podman CLI: available/);
    assert.match(ioInstall.stdoutText, /PASS Podman Compose: available/);
    assert.match(ioInstall.stdoutText, /PASS Podman Engine: available/);
    assert.ok(executed.some((cmd) => cmd.startsWith("podman compose ")));
    assert.ok(!executed.some((cmd) => cmd.startsWith("docker ")));

    executed.length = 0;
    const ioStatus = createIo();
    const statusCode = await run(["status"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdin: ioStatus.stdin,
      stdout: ioStatus.stdout,
      stderr: ioStatus.stderr,
      execute
    });
    assert.equal(statusCode, 0);
    assert.equal(executed.length, 1);
    assert.match(executed[0], /^podman compose /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCli install --engine auto and SPACEAPP_CONTAINER_ENGINE select podman when docker is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spaceapp-podman-auto-"));
  try {
    const execute = async (spec, io) => {
      if (spec.command === "docker") return 127;
      if (spec.command === "podman" && spec.args?.[0] === "info") {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.3.0" },
          host: { cgroupVersion: "v2", cpus: 8, memTotal: 17179869184 },
          store: { graphRoot: root }
        }));
      }
      return 0;
    };

    const ioInstall = createIo();
    const code = await run(["install", "--engine", "auto", "--profile", "light", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdin: ttyStdin("", "", "", "", "", "y"),
      stdout: ioInstall.stdout,
      stderr: ioInstall.stderr,
      execute,
      prepareDockerPath: async () => null,
      inspectResources: async () => ({
        cpuCount: 8,
        totalMemoryBytes: 16 * 1024 ** 3,
        freeDiskBytes: 50 * 1024 ** 3
      }),
      request: async (url) => {
        if (url.endsWith("/readyz")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ setupRequired: true, expiresAt: "2099-01-01T00:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    assert.equal(code, 0, `STDERR: ${ioInstall.stderrText}\nSTDOUT: ${ioInstall.stdoutText}`);
    const saved = await loadConfig(root);
    assert.equal(saved.engine, "podman");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
