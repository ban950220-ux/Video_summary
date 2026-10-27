# Exact-version release adapter: offline proposal v4

## Status and scope

This is an isolated proposal. The fixed v2 and v3 packages are preserved separately.
It is not imported by deploy-production, production package commands, Worker code,
or Wrangler configuration. Its offline tests now run in repository CI with the
committed frozen artifact fixture; CI does not activate production execution. There is no HTTP client,
credential loader, CLI, remote authorization reader, or automatic activation.
Every result says `productionExecutionSupported: false`. Injected fixture
callbacks are a test seam, not a security boundary or a real permission grant.
No account request, upload, deployment, D1 mutation or AI call was executed.

Base candidate is main `6c3f309c30f270d696fecc581cd928532c767499`, tree
`d5ac6ab65696e06484809794867610f6658fa97a`. The local base commit `00d90fd174d8def24a5d4d7295ace6a5a5b3bcc8`
has that exact tree. PR38 and the previous v1 proposal are not included.
The previous fixed v1 patch remains unchanged; its unsupported secret revisions,
remote asset inventory requirement, server CAS and Map-only model are not reused.

Fixed baseline: `adc0e786-5fdf-4daf-bea1-02304de1e1b0` on `holy-rice-b914`.
The parent has relayed the owner's narrow one-release policy approval. This does
not supply the missing account metadata, bundle review, compatibility or execution
window evidence. No executable approval record is manufactured here. No equality
of other hidden Secret values is asserted.
No placeholders in these tests are actual owner approval or compatibility proof.

## Minimum proposed flow

1. Verify exact account / immutable Worker ID / name, exact baseline deployment,
   API compatibility, known binding names/types and D1 ID. Unknowns block.
2. Bind owner and independent review, short approval expiry, single-writer window,
   candidate module digest and complete asset digest. These are normalized local
   contract fields, not claimed Cloudflare API response fields.
3. Derive the operation key from account + Worker identity + baseline + candidate
   commit/tree/modules/assets + intent. Approval IDs are excluded. A new approval
   cannot reset the same operation.
4. Take an atomic local directory lock and publish the initial claim before writes.
   Each journal record is an immutable numbered JSON file, written to a temporary
   file, flushed, then hard-linked atomically to its final name without replacement.
   Temporary leftovers never authorize a retry. Corruption/gaps stop execution.
5. Upload the complete reviewed asset manifest through a mock session and requested
   buckets; use its completion JWT for the version body. Persist request hashes,
   never the JWT, Authorization header, source modules, or binding values.
6. Create a version with `deploy=false`. Each preserved binding specifies
   `type=inherit, version_id=<exact baseline UUID>`. ASSETS is explicitly the new
   reviewed asset set. No `latest`, renames, secret replacements, or Worker creation.
7. Separately GET the exact created version including modules; check candidate code,
   runtime configuration and binding metadata. Asset-set acceptance relies on the
   platform applying the completion token in the recorded create request, not a
   nonexistent independent remote asset inventory or Secret equality proof.
8. Recheck approved baseline deployment ID/settings/window/expiry immediately
   before a separate promotion with `force=false`, one exact version at 100%.
   An ACK alone is not completion: GET deployments and fresh normalized metadata
   must agree. Drift or an uncertain response never triggers automatic rollback.

## Persistence and uncertain results

The directory must be the single authoritative store for this local executor.
The tests use separate temporary directories for isolation. Separate machines,
other store directories and Dashboard writers are outside this local lock.
This is not a Cloudflare server CAS or an exactly-once network guarantee.

Every mutating fixture request has a pending journal entry before dispatch.
Mutating calls are never automatically retried. On lost version-create ACK, a
bounded list lookup by unique attempt tag followed by an exact version GET can
recover a matching candidate. The limit is five pages of 100 entries. Each response
must provide consistent page/per_page/total_count/total_pages metadata and the
expected number of unique version IDs. Missing metadata, a truncated page, changed
totals, duplicate IDs, a budget overrun, zero matches or multiple matches keeps the
operation uncertain. An incomplete first-page match cannot authorize promotion.
Absence is not proof of no creation. Pagination is not an atomic snapshot; it relies
on the separately reviewed single-writer window. A promotion's lost ACK is resolved
by deployment GET.
Asset-stage uncertainty stays blocked; this minimal proposal does not restart
asset sessions or regenerate completion tokens. Review expiry does not forbid
read-only reconciliation but forbids new writes.

Process crashes leave the lock in place, deliberately blocking a second process.
This proposal has no automatic stale-lock takeover, reset, or production repair
command. An operator would first establish that the owning process is stopped,
preserve the journal, and authorize read-only reconciliation before unlocking.
File fsync + atomic hard-link publication is tested on the local filesystem for
process failure; sudden power loss, network shares and adversarial file editing
are not certified. Store loss must never be treated as permission to replay.

## API mapping and evidence limits

Official request JSON fields are used for asset sessions, version creation and
deployment. `method/path/query/headers/multipart` are local HTTP request descriptor
fields, not fields sent inside Cloudflare JSON. Multipart serialization and real
authentication are intentionally not implemented.

- [Version creation](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/)
  provides exact-version `inherit`; legacy upload only supports `latest`.
- [Direct asset upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)
  documents manifest path/hash/size, bucket uploads, and completion JWT.
  API file hash follows its example: SHA256(base64(bytes) + extension), first 32
  hex characters. This is distinct from the retained full-file SHA256 and complete
  candidate manifest digest `09e9fdd7ae49f3753818f7566219db990909f9822fa27d8c2dfef90fca041467`.
- [Version GET](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/)
  supports `include=modules`; this proposal does not execute it or authorize reading
  any previously denied settings. A future approved reader must avoid returning
  private binding values or raw account responses to logs.
  D1 response metadata is normalized from the canonical `database_id`. The legacy
  `id` alias is supported, but each present field must be a UUID and both must agree
  when present. A matching legacy ID cannot hide a changed canonical database ID.
- [Version list](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/list/)
  supports page/per_page (maximum 100) and optional result_info. Without sufficient
  pagination metadata this adapter stays uncertain rather than assuming completion.
- [Deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)
  is separate; `force=false` remains explicit. There is no claimed conditional
  server deployment write or remote global lock.

The normalized observation must include known version settings, Worker-level
settings/exposure digest, baseline binding metadata, and supported API mapping.
This minimal adapter handles the reviewed compatibility date, empty flags and
run_worker_first=true only. Other runtime settings require review, never defaults
guessed as preservation. A new full asset manifest can remove remote-only assets
from the new version. D1 data is not versioned or changed by this proposal.

## Verification and remaining work

State-machine tests use the eight committed frozen Git/LF candidate asset files,
**synthetic Worker modules and mock Cloudflare responses**. The wire tests separately
use the real frozen production bundle. All owner/remote observations remain fixtures. They do not certify the production bundle,
existing key permissions, exact Worker API compatibility, current metadata,
single-writer window, or owner approval. No automatic rollback is implemented.
Rollback intent must name adc0e786 explicitly and must not force past another
writer's changes; Cloudflare resource/data rollback limitations still apply.

Regression cases include missing approval/identity/metadata, unsupported bindings,
expiry after the last await and journal write, asset mutations and missing tokens,
separate creation/promotion, module/metadata drift, ACK loss, read reconciliation,
real two-process competition, process restart, new approval ID, and crash locks.

Local result: 39 original proposal cases, 30 API boundary regressions, 14 freshness
regressions and 25 existing deployment-runtime/policy/postcheck cases passed
(108 total, no skips).
`npm run check` passed. The full application
suite was not rerun; no existing application or deployment file was edited.

The same three selected API probes fail against preserved v2 (canonical-only D1,
conflicting D1 aliases, and a second tag match on page 2) and pass against v3.
This is an author regression replay, not a replacement for independent review.

V4 fixes post-promotion freshness arithmetic that previously subtracted a timestamp
from the `now` function object, producing NaN and bypassing the age check. After the
final observation await, one numeric `checkedAt` is captured and validated. Ages
0, 59999 and 60000 milliseconds are accepted; 60001 and 3600000 milliseconds,
future observations, invalid timestamps and invalid current-clock values are
rejected without appending CONFIRMED or issuing another write. Read-only recovery
after approval expiry remains supported when its new observation is fresh. Three
selected probes fail against preserved v3 and pass against v4.

Separately, the real candidate production bundle was produced from all 224 exact
Git blobs with installed lock-matched Wrangler 4.149.0/esbuild 0.28.2. Its 37 source
inputs are candidate files, not these proposal files. The single `site-worker.js`
module is 897758 bytes, SHA256
`8d83ed98f2416ab26bfc99d51ed3d1686a93ee9e22db8bffd585e3aee2a3f031`.
The normalized module-payload digest is
`e8b67790b2e6eae73d7194c49d2a4f07a52f919816664d4a701c1c75c74e48e1`.
Wrangler's initial sandbox build had an OS directory-access error; the approved
local elevated dry-run completed. Authentication/config directories were empty,
metrics disabled, and a Node network-denial preload blocked one network attempt
in each dry-run. No upload occurred. The CI Dashboard artifact is a different
embedded-assets build and is not substituted for the production module. The
bundle evidence is separate from this proposal and is not remote compatibility
or deployment approval evidence.

Before any production integration: independent review, exact bundle construction
and review, narrowly authorized metadata/capability reader, owner approval for
the changed evidence model, and a reviewed authenticated transport are required.
Previously denied reads remain denied. No changes to the existing default guard
or uploader are part of this patch.

## 2026-10-27 handoff integration correction

Write-capable observations must now be collected at or after the separately
reviewed single-writer window starts. The original <=60-second age check alone
accepted snapshots from before that window. Six regressions cover initial and
final reads, promotion, the inclusive start boundary, and historical read-only
reconciliation after the window or approval has expired. No new write authority,
retry path, lock takeover or production transport is introduced.

See [handoff integration evidence](RELEASE_HANDOFF_INTEGRATION.md) for the original
119-case baseline, corrected 125-case run, artifact reconstruction and PR39 split.
