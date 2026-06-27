import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface TestState {
	moduleLoads?: number;
	dependencyLoads?: number;
	localHelperLoads?: number;
	factoryRuns?: number;
}

function state(): TestState {
	const global = globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState };
	if (!global.__extensionFactoryCacheTest) {
		global.__extensionFactoryCacheTest = {};
	}
	return global.__extensionFactoryCacheTest;
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionFactoryCacheTest?: TestState }).__extensionFactoryCacheTest;
}

function writeCountingExtension(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

function writeVersionCommandExtension(filePath: string, version: string): void {
	writeFileSync(
		filePath,
		`
export default function (pi) {
	pi.registerCommand("version", {
		description: ${JSON.stringify(version)},
		handler() {},
	});
}
`,
		"utf-8",
	);
}

function writeModulePackageJson(directory: string): void {
	writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", main: "./index.ts" }), "utf-8");
}

function createTestResourceLoader(cwd: string, agentDir: string): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
}

function writeCountingDependency(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.dependencyLoads = (state.dependencyLoads ?? 0) + 1;
export const value = state.dependencyLoads;
`,
		"utf-8",
	);
}

function writeExtensionWithDependency(filePath: string, specifier = "side-effect-dependency"): void {
	writeFileSync(
		filePath,
		`
import { value } from ${JSON.stringify(specifier)};

const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	if (value < 1) throw new Error("Dependency was not loaded");
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

function writeCountingLocalHelper(filePath: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.localHelperLoads = (state.localHelperLoads ?? 0) + 1;
export const value = state.localHelperLoads;
`,
		"utf-8",
	);
}

function writeExtensionWithLocalHelper(filePath: string): void {
	writeFileSync(
		filePath,
		`
import { value } from "./lib/helper.ts";

const state = (globalThis.__extensionFactoryCacheTest ??= {});
state.moduleLoads = (state.moduleLoads ?? 0) + 1;

export default function () {
	if (value < 1) throw new Error("Local helper was not loaded");
	state.factoryRuns = (state.factoryRuns ?? 0) + 1;
}
`,
		"utf-8",
	);
}

describe("extension factory cache", () => {
	const roots: string[] = [];

	function fixture(name: string) {
		const root = join(tmpdir(), `pi-extension-cache-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		return { root, cwd, agentDir };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it("caches extension modules for cached same-cwd loads but reruns factories", async () => {
		const { root, cwd } = fixture("same-cwd");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		const first = await loadExtensionsCached([extensionPath], cwd);
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(first.errors).toEqual([]);
		expect(second.errors).toEqual([]);
		expect(state().moduleLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
		expect(first.extensions[0]).not.toBe(second.extensions[0]);
		expect(first.runtime).not.toBe(second.runtime);
	});

	it("does not cache direct loadExtensions calls", async () => {
		const { root, cwd } = fixture("direct");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensions([extensionPath], cwd);
		await loadExtensions([extensionPath], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("clears the entrypoint cache on resource loader reload", async () => {
		const { cwd, agentDir } = fixture("reload");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeCountingExtension(join(extensionDir, "counting.ts"));
		const loader = createTestResourceLoader(cwd, agentDir);

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it.each(["ts", "js"])("reloads changed extension entrypoint code from .%s files", async (extension) => {
		const { cwd, agentDir } = fixture(`reload-entrypoint-change-${extension}`);
		const extensionDir = join(agentDir, "extensions");
		const extensionPath = join(extensionDir, `version.${extension}`);
		mkdirSync(extensionDir, { recursive: true });
		writeVersionCommandExtension(extensionPath, "v1");
		const loader = createTestResourceLoader(cwd, agentDir);

		await loader.reload();
		expect(loader.getExtensions().extensions[0]?.commands.get("version")?.description).toBe("v1");

		writeVersionCommandExtension(extensionPath, "v2");
		await loader.reload();

		expect(loader.getExtensions().extensions[0]?.commands.get("version")?.description).toBe("v2");
	});

	it("reloads local extension helpers on resource loader reload", async () => {
		const { cwd, agentDir } = fixture("reload-local-helper");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(extensionDir, { recursive: true });
		mkdirSync(join(extensionDir, "lib"), { recursive: true });
		writeCountingLocalHelper(join(extensionDir, "lib", "helper.ts"));
		writeExtensionWithLocalHelper(join(extensionDir, "extension.ts"));
		const loader = createTestResourceLoader(cwd, agentDir);

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(2);
		expect(state().localHelperLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("preserves dependency cache on resource loader reload", async () => {
		const { cwd, agentDir } = fixture("reload-dependency");
		const extensionDir = join(agentDir, "extensions");
		const dependencyDir = join(extensionDir, "node_modules", "side-effect-dependency");
		mkdirSync(extensionDir, { recursive: true });
		mkdirSync(dependencyDir, { recursive: true });
		writeModulePackageJson(dependencyDir);
		writeCountingDependency(join(dependencyDir, "index.ts"));
		writeExtensionWithDependency(join(extensionDir, "extension.ts"));
		const loader = createTestResourceLoader(cwd, agentDir);

		await loader.reload();
		await loader.reload();

		expect(state().moduleLoads).toBe(2);
		expect(state().dependencyLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
	});

	it("reloads changed package extension entrypoint code", async () => {
		const { root, cwd } = fixture("reload-package-entrypoint-change");
		const extensionDir = join(root, "node_modules", "extension-package");
		const extensionPath = join(extensionDir, "index.ts");
		mkdirSync(extensionDir, { recursive: true });
		writeModulePackageJson(extensionDir);
		writeVersionCommandExtension(extensionPath, "v1");

		const first = await loadExtensions([extensionPath], cwd);
		expect(first.errors).toEqual([]);
		expect(first.extensions[0]?.commands.get("version")?.description).toBe("v1");

		writeVersionCommandExtension(extensionPath, "v2");
		const second = await loadExtensions([extensionPath], cwd);

		expect(second.errors).toEqual([]);
		expect(second.extensions[0]?.commands.get("version")?.description).toBe("v2");
	});

	it("reloads local helpers for package extension reload", async () => {
		const { root, cwd } = fixture("reload-package-local-helper");
		const extensionDir = join(root, "node_modules", "extension-package");
		mkdirSync(join(extensionDir, "lib"), { recursive: true });
		writeModulePackageJson(extensionDir);
		writeCountingLocalHelper(join(extensionDir, "lib", "helper.ts"));
		writeExtensionWithLocalHelper(join(extensionDir, "index.ts"));

		await loadExtensions([join(extensionDir, "index.ts")], cwd);
		await loadExtensions([join(extensionDir, "index.ts")], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().localHelperLoads).toBe(2);
		expect(state().factoryRuns).toBe(2);
	});

	it("preserves nested dependency cache for package extension reload", async () => {
		const { root, cwd } = fixture("reload-package-dependency");
		const extensionDir = join(root, "node_modules", "extension-package");
		const dependencyDir = join(extensionDir, "node_modules", "side-effect-dependency");
		mkdirSync(dependencyDir, { recursive: true });
		writeModulePackageJson(extensionDir);
		writeModulePackageJson(dependencyDir);
		writeCountingDependency(join(dependencyDir, "index.ts"));
		writeExtensionWithDependency(join(extensionDir, "index.ts"));

		await loadExtensions([join(extensionDir, "index.ts")], cwd);
		await loadExtensions([join(extensionDir, "index.ts")], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().dependencyLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
	});

	it("preserves hoisted scoped dependency cache for scoped package extension reload", async () => {
		const { root, cwd } = fixture("reload-hoisted-scoped-dependency");
		const extensionDir = join(root, "node_modules", "@plannotator", "pi-extension");
		const dependencyDir = join(root, "node_modules", "@pierre", "diffs");
		mkdirSync(extensionDir, { recursive: true });
		mkdirSync(dependencyDir, { recursive: true });
		writeModulePackageJson(extensionDir);
		writeModulePackageJson(dependencyDir);
		writeCountingDependency(join(dependencyDir, "index.ts"));
		writeExtensionWithDependency(join(extensionDir, "index.ts"), "@pierre/diffs");

		await loadExtensions([join(extensionDir, "index.ts")], cwd);
		await loadExtensions([join(extensionDir, "index.ts")], cwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().dependencyLoads).toBe(1);
		expect(state().factoryRuns).toBe(2);
	});

	it("keeps the cache scoped to one cwd", async () => {
		const { root } = fixture("cross-cwd");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath);

		await loadExtensionsCached([extensionPath], firstCwd);
		await loadExtensionsCached([extensionPath], secondCwd);
		await loadExtensionsCached([extensionPath], secondCwd);

		expect(state().moduleLoads).toBe(2);
		expect(state().factoryRuns).toBe(3);
	});
});
