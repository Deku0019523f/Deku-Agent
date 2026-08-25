import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectContext {
  language: string;
  framework: string | null;
  packageManager: string | null;
  hasGit: boolean;
  gitBranch: string | null;
  fileCount: number;
  testFileCount: number;
  hasEnvFile: boolean;
  dependencies: string[];
  scripts: Record<string, string>;
  importantFiles: string[];
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "__pycache__", ".venv", "venv", ".cache", "coverage",
]);

// Signatures framework -> nom de dépendance qui le trahit
const FRAMEWORK_SIGNATURES: Record<string, string[]> = {
  Express: ["express"],
  "Next.js": ["next"],
  React: ["react"],
  Vue: ["vue"],
  NestJS: ["@nestjs/core"],
  Fastify: ["fastify"],
  Baileys: ["@whiskeysockets/baileys", "baileys"],
  "discord.js": ["discord.js"],
  "node-telegram-bot-api": ["node-telegram-bot-api"],
  Django: ["django"],
  Flask: ["flask"],
  FastAPI: ["fastapi"],
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(dir: string, isTestFile: (name: string) => boolean): Promise<{ total: number; tests: number }> {
  let total = 0;
  let tests = 0;

  async function walk(current: string) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(current, entry.name));
      } else if (entry.isFile()) {
        total++;
        if (isTestFile(entry.name)) tests++;
      }
      if (total > 10000) return; // garde-fou très gros projets
    }
  }

  await walk(dir);
  return { total, tests };
}

async function detectGit(cwd: string): Promise<{ hasGit: boolean; branch: string | null }> {
  const hasGit = await exists(join(cwd, ".git"));
  if (!hasGit) return { hasGit: false, branch: null };

  try {
    const headContent = await readFile(join(cwd, ".git", "HEAD"), "utf-8");
    const match = headContent.match(/ref: refs\/heads\/(.+)/);
    return { hasGit: true, branch: match ? match[1].trim() : null };
  } catch {
    return { hasGit: true, branch: null };
  }
}

async function scanNodeProject(cwd: string): Promise<Partial<ProjectContext> | null> {
  const pkgPath = join(cwd, "package.json");
  if (!(await exists(pkgPath))) return null;

  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const depNames = Object.keys(deps);

  let framework: string | null = null;
  for (const [name, signatures] of Object.entries(FRAMEWORK_SIGNATURES)) {
    if (signatures.some((sig) => depNames.includes(sig))) {
      framework = name;
      break;
    }
  }

  let packageManager = "npm";
  if (await exists(join(cwd, "bun.lockb"))) packageManager = "bun";
  else if (await exists(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(join(cwd, "yarn.lock"))) packageManager = "yarn";

  return {
    language: "Node.js" + (await exists(join(cwd, "tsconfig.json")) ? " (TypeScript)" : ""),
    framework,
    packageManager,
    dependencies: depNames.slice(0, 40),
    scripts: pkg.scripts ?? {},
  };
}

async function scanPythonProject(cwd: string): Promise<Partial<ProjectContext> | null> {
  const hasReq = await exists(join(cwd, "requirements.txt"));
  const hasPyproject = await exists(join(cwd, "pyproject.toml"));
  if (!hasReq && !hasPyproject) return null;

  let depNames: string[] = [];
  if (hasReq) {
    const content = await readFile(join(cwd, "requirements.txt"), "utf-8");
    depNames = content
      .split("\n")
      .map((l) => l.split(/[=<>~! ]/)[0].trim())
      .filter(Boolean);
  }

  let framework: string | null = null;
  for (const [name, signatures] of Object.entries(FRAMEWORK_SIGNATURES)) {
    if (signatures.some((sig) => depNames.some((d) => d.toLowerCase() === sig))) {
      framework = name;
      break;
    }
  }

  return {
    language: "Python",
    framework,
    packageManager: hasPyproject ? "poetry/pip" : "pip",
    dependencies: depNames.slice(0, 40),
    scripts: {},
  };
}

export async function scanProject(cwd: string): Promise<ProjectContext> {
  const nodeInfo = await scanNodeProject(cwd);
  const pythonInfo = nodeInfo ? null : await scanPythonProject(cwd);
  const langInfo = nodeInfo ?? pythonInfo ?? {
    language: "Inconnu",
    framework: null,
    packageManager: null,
    dependencies: [],
    scripts: {},
  };

  const { hasGit, branch } = await detectGit(cwd);
  const { total, tests } = await countFiles(cwd, (name) =>
    /\.(test|spec)\.[jt]sx?$/.test(name) || /test_.*\.py$/.test(name) || /_test\.py$/.test(name)
  );
  const hasEnvFile = await exists(join(cwd, ".env"));

  const importantFiles: string[] = [];
  for (const f of ["package.json", "tsconfig.json", "requirements.txt", "pyproject.toml", "README.md", ".env.example", "docker-compose.yml", "Dockerfile"]) {
    if (await exists(join(cwd, f))) importantFiles.push(f);
  }

  return {
    language: langInfo.language ?? "Inconnu",
    framework: langInfo.framework ?? null,
    packageManager: langInfo.packageManager ?? null,
    hasGit,
    gitBranch: branch,
    fileCount: total,
    testFileCount: tests,
    hasEnvFile,
    dependencies: langInfo.dependencies ?? [],
    scripts: langInfo.scripts ?? {},
    importantFiles,
  };
}

/** Résumé compact à injecter dans le prompt système — pas de liste de 500 fichiers. */
export function formatProjectContext(ctx: ProjectContext): string {
  const lines = [
    `Langage: ${ctx.language}`,
    ctx.framework ? `Framework: ${ctx.framework}` : null,
    ctx.packageManager ? `Package manager: ${ctx.packageManager}` : null,
    `Fichiers: ${ctx.fileCount} (dont ${ctx.testFileCount} fichiers de test)`,
    ctx.hasGit ? `Git: repository (branche: ${ctx.gitBranch ?? "?"})` : "Git: pas de repository",
    ctx.hasEnvFile ? "Fichier .env détecté" : null,
    ctx.importantFiles.length ? `Fichiers clés: ${ctx.importantFiles.join(", ")}` : null,
    ctx.dependencies.length ? `Dépendances principales: ${ctx.dependencies.slice(0, 15).join(", ")}` : null,
    Object.keys(ctx.scripts).length ? `Scripts: ${Object.keys(ctx.scripts).join(", ")}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}
