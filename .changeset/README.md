# Changesets

Version and publish `@oomol-lab/open-connector` (under `packages/open-connector`) with Changesets.

```bash
# describe a change
npm run changeset

# bump versions + changelogs from pending changesets
npm run version-packages

# publish to the configured npm registry (requires auth)
npm run release
```

The monorepo root (`open-connector-monorepo`) and `web` (`@oomol/connect-web`) stay private and are
not published.

Set `"access": "public"` in `config.json` if publishing a public scoped package to npmjs.com.
