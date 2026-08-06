# L0 — resolve the host-side build inputs (prerequisite to every build)

**Runs host-side.** Populates the two documented slots the build verb refuses-until-resolved, so the
image is byte-reproducible against a pinned base + a known stub census. Do this once per base/stub
change; commit the resolved slots so the pin is durable.

## L0.1 — resolve the digest-pinned base

The VM seat cannot pull/inspect a registry digest; do it on the host with a runtime present.

```bash
# Pull the intended LTS-slim base, then read its immutable RepoDigest.
docker pull debian:bookworm-slim
BASE_REF="$(docker inspect --format '{{index .RepoDigests 0}}' debian:bookworm-slim)"
echo "${BASE_REF}"          # e.g. debian@sha256:<64-hex>  (or docker.io/library/debian@sha256:...)
```

Write the single resolved reference into the slot (replacing the comment block):

```bash
printf '%s\n' "${BASE_REF}" > docker/testbed/base-image
# Prove the fence accepts it (readBaseImage returns the digest, or exits non-zero):
node -e 'import("./scripts/testbed-build-inputs.mjs").then(m=>console.log(m.readBaseImage("docker/testbed/base-image")))'
```

**PASS:** `readBaseImage` prints `{ ref, name, digest: 'sha256:<64-hex>' }`. **FAIL:** any non-zero /
"tag-floating" / "unresolved" — the slot is not a valid digest pin; do not proceed to a build.

## L0.2 — finalize the stub-assets census list

The zero-token stub payload (plan §1 layer 4) is the container-local stub `rig.yaml` + its agent
fixture + `culture.md` that L3 boots. Add each repo-relative path, one per line, to
`docker/testbed/stub-assets.list` (comments/blanks ignored). Ground the exact set against L3 (the
`rig up` stub topology it settles) — do not guess; the list IS the census scope the manifest hashes.

```bash
# After populating the list, prove the census resolves over the staged set the build will stage:
node -e 'import("./scripts/testbed-build-inputs.mjs").then(m=>{
  const fs=require("fs");
  const files=fs.readFileSync("docker/testbed/stub-assets.list","utf8").split("\n").map(s=>s.replace(/#.*/,"").trim()).filter(Boolean);
  console.log(m.deriveStubAssetsHash(".", files).receipt);
})'
```

**PASS:** the receipt lists exactly the intended stub assets, each with a 64-hex content digest.
**FAIL:** empty set / a missing file / a path escaping the root — fix the list, never a partial census.

## L0.3 — record evidence

```bash
GIT_SHA="$(git rev-parse HEAD)"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
{ echo "docker: $(docker --version)"; echo "base: ${BASE_REF}"; echo "stub-assets.list:"; cat docker/testbed/stub-assets.list; } > "${EVID}/L0-inputs.txt"
echo "VERDICT: PASS — base digest pinned + stub census resolved" >> "${EVID}/L0-inputs.txt"
```
