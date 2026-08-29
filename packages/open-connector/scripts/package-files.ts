import { cp, lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const repoRoot = join(packageRoot, "..", "..");

/**
 * Materialize src/migrations into the package so `npm pack` / Changesets publish
 * include real files (npm does not pack symlinks that escape the package root).
 */
export async function materializePackageContents(): Promise<void> {
  for (const name of ["src", "migrations"]) {
    const target = join(packageRoot, name);
    await rm(target, { recursive: true, force: true });
    await cp(join(repoRoot, name), target, { recursive: true });
  }
}

/**
 * Restore development symlinks after pack/publish.
 */
export async function restorePackageSymlinks(): Promise<void> {
  for (const name of ["src", "migrations"]) {
    const target = join(packageRoot, name);
    await rm(target, { recursive: true, force: true });
    await symlink(join("..", "..", name), target);
  }
  for (const name of ["README.md", "LICENSE.txt", "NOTICE.md"]) {
    const target = join(packageRoot, name);
    try {
      const stats = await lstat(target);
      if (!stats.isSymbolicLink()) {
        continue;
      }
    } catch {
      await symlink(join("..", "..", name), target);
    }
  }
}
