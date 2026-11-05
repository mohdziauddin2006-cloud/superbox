# Security

## Reporting

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/mohdziauddin2006-cloud/superbox/security/advisories/new)
and include:

- the affected platform and version,
- a short reproduction,
- the impact you believe it has,
- any suggested fix.

You can expect an acknowledgement within a few days.

## Scope

In scope: the Android app, the Electron app, the loopback servers, the build
scripts and anything that could expose local files, credentials or network
access.

Out of scope: the availability, legality or content of third-party catalogues
and streams. SuperBox does not host media; report those issues to the source.

## Secrets

The signing keystore, `android/build.local.ps1` and any local environment files
are git-ignored. If you believe a secret was committed, report it privately so
the release key or token can be rotated.
