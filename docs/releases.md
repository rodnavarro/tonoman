# Releases

The runtime ships as one image, `ghcr.io/rodnavarro/tonoman`, built by `.github/workflows/publish-images.yml`
from `build/gateway/Containerfile`. The same image runs as the worker and as the auth sidecar, on the
Cloud's pool and on a person's own machine.

## Cutting a release

```
git tag v0.2.0
git push origin v0.2.0
```

The workflow scans the tree with the leak guard, builds the image with `TONOMAN_VERSION=v0.2.0`
baked in, and pushes `:v0.2.0` and `:latest`. The worker logs its version at boot:

```
worker: tonoman v0.2.0 serving tonoman-cloud-turns on …
```

Every merge to `main` also publishes `:<short sha>`, so any commit is pullable, and a same-repo pull
request publishes `:pr-<n>` for testing. Neither moves `:latest`; only a version tag does.

## Versions

Semantic versions, `vMAJOR.MINOR.PATCH`. A minor bump is the normal release. A major bump is reserved
for a change the control plane cannot serve alongside the previous line.

## Compatibility promise

The control plane (Tonoman Cloud) serves the current release and the one before it. A worker two
releases behind is told so at boot and should be updated. Installers pin `:latest` on first install and
update on request, never on their own.

## First publish

GHCR packages start private. After the first successful run, set the package's visibility to Public
under the repository's Packages settings, once.
