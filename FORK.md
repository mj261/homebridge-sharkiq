# mj261's SharkIQ fork

This fork keeps RV3020XEUS Matter cleaning support in TypeScript source so it
survives rebuilding and can be merged with future upstream releases.

## Current behavior

| Apple Home method | Shark Operating_Mode |
| --- | --- |
| Vacuum | 6 |
| Mop | 7 |
| Vacuum + Mop | 8 |

These values were observed on RV3020XEUS hardware using SharkClean. Generic
start (2) produced wet-only cleaning. Mode selection in Home prepares the next
start without moving the robot. Modes 6–8 report as running; other models retain
the upstream command path. Model discovery uses Device_Model_Number, and API
debug output excludes the full device response.

The RV3020's live robot status distinguishes cleaning, seeking the charger,
charging, and docked states even when its older DockedStatus property is stale.
Each cleaning method is advertised at Eco, Normal, and Max suction, allowing
Apple Home to present both its cleaning-method and speed selectors. A speed can
be changed during a job without changing the active cleaning method.
The fork also loads Shark's MARD map file: Home receives every user-facing room
name while room commands are translated back to the internal `AZ_N` identifiers
the robot expects. Whole-house and room jobs are supported. Dock before changing
the method. Matter also reports the base's emptying, mop-cleaning, and refilling
operations; explicit clean/dirty water conditions and dock errors; and the
current room plus pending/operating/completed/skipped room status. A single-room
job receives an estimated end time when Shark supplies a usable percentage.
Whole-house ETA is deliberately omitted because Shark reports mission-wide—not
per-room—percentage. Resume sends the selected explicit method; whether the firmware
continues the same job or starts a new job still needs hardware confirmation.
Pause and dock keep upstream's commands. Selection defaults to Vacuum after
restarting Homebridge. Undocumented `Warning_Code` values remain visible in
debug diagnostics but are not presented as failures: the RV3020 reports warning
8 during a healthy vacuum-only mission.

## Installation and update policy

The npm package name and Homebridge platform identity remain
`@homebridge-plugins/homebridge-sharkiq` / `SharkIQ` to minimize migration changes.
Only one copy of the plugin should be installed. This fork does not publish to
the upstream npm package.

**Install this fork's built release packages. Do not use the ordinary SharkIQ
update button or include SharkIQ in a generic automatic plugin update job.**
An explicit registry update can still replace this fork. Package pinning and a
GitHub fork do not block someone from deliberately installing the upstream
package. Homebridge itself and unrelated plugins can update normally.

Download the `.tgz` and `SHA256SUMS` from this fork's GitHub Releases page and
verify them together with `sha256sum -c SHA256SUMS`. The archive is a complete
npm package, not the earlier three-file overlay: **install it with npm**, not by
extracting it over the plugin directory.

On the Homebridge machine, first make a Homebridge backup in the UI. Then, for
the first release (adjust filenames for subsequent releases):

```bash
sudo mkdir -p /var/lib/homebridge/plugin-releases
sudo cp homebridge-plugins-homebridge-sharkiq-1.6.5-mj261.6.tgz /var/lib/homebridge/plugin-releases/
sudo tar -czf "$HOME/sharkiq-before-fork-$(date +%Y%m%d-%H%M%S).tgz" \
  -C /var/lib/homebridge/node_modules/@homebridge-plugins homebridge-sharkiq
sudo cp -a /var/lib/homebridge/package.json /var/lib/homebridge/plugin-releases/package.before-fork.json
# Also save package-lock.json here if it exists.
sudo hb-service stop
sudo env PATH="/opt/homebridge/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  /opt/homebridge/bin/npm --prefix /var/lib/homebridge install --save-exact \
  /var/lib/homebridge/plugin-releases/homebridge-plugins-homebridge-sharkiq-1.6.5-mj261.6.tgz
sudo hb-service start
```

The saved dependency points to the local release archive; keep that archive in
place for future reinstalls. Check Homebridge's logs and all three modes after
installing. Do not clear pairing data or remove the accessory as part of normal
installation. If installation fails after stopping, start Homebridge again and
use the full Homebridge backup to recover. Roll back future fork versions by
installing the previous retained `.tgz` with the same npm command.

## Build and release

```bash
npm ci
npm run lint
npm run build
npm test
npm pack
```

The build includes the custom settings UI. The compiled `dist` directory is
generated and remains untracked. Changes belong in `src`, alongside tests.

`Fork build and release` runs lint/build/tests on Node 22, 24, and 26 for pushes,
pull requests, and manual runs. The Node 24 job uploads a `sharkiq-package`
artifact with the complete package and checksum. Publishing a GitHub release
whose tag equals `v` plus the package version reruns the checks and attaches
the package only when all jobs pass. Example: `v1.6.5-mj261.1`.

Fork releases use versions such as `1.6.5-mj261.1`, `1.6.5-mj261.2`, and then
`1.6.6-mj261.1` after merging upstream 1.6.6. Use
`npm version VERSION --no-git-tag-version` to update both manifests before
committing. GitHub Actions must be enabled in the fork. No npm credentials are
required; the upstream npm-publishing and deprecation jobs are restricted to
the upstream repository.

## Incorporating upstream updates

The fork's `latest` branch includes the custom commits. The original repository
is the `upstream` remote. Start from a clean, current checkout of this fork:

```bash
git switch latest
git pull --ff-only origin latest
bash scripts/merge-upstream.sh
```

The script fetches upstream, creates a review branch from the current checkout,
merges upstream/latest, and runs checks. It stops on conflicts; resolve them
while preserving the RV3020 tests and fork workflow. It does not push, publish,
deploy, reset branches, or discard changes. An optional first argument selects
a fetched release tag or commit instead of upstream/latest.

Review the result, update the fork version in both manifests, and open a pull
request **into mj261/homebridge-sharkiq:latest**. After merging and successful
checks, create a versioned GitHub release and install its package. Avoid forced
fork synchronization, which can discard the custom commits.

## Validation

The tests cover command mapping, selection/start separation, RV3020 live-state
translation, dock operations and maintenance errors, live area/progress/ETA,
MARD room parsing, display-name-to-zone translation, polling, restored handlers,
other-model behavior, and diagnostic filtering. They use
synthetic fixtures, not account logs or credentials. Hardware and Apple Home
presentation still require confirmation on the installed release.

Original project: https://github.com/homebridge-plugins/homebridge-sharkiq
Original Apache-2.0 license and attribution are retained.
