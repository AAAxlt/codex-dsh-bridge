# Validation record

This document separates the existing development evidence from checks performed for the initial public source upload. It makes no claim about community adoption or independent certification.

## Source provenance

The upload starts from the 1.0.2 development candidate. On 2026-10-21, all **34** files in its source, tests, plugin adapter, maintenance scripts, package manifests, TypeScript configuration, and usage notes were compared by SHA-256 with the installed Linux 1.0.2 tree. All matched before publication metadata and documentation were added.

No DSH binaries, SDK packages, private task homes, model logs, machine credentials, or installation-specific baselines are included. Publication does not replace the existing local runtime or switch its launcher.

The first clean GitHub run exposed two read-only unit assertions coupled to an installed DSH bundle. These assertions were preserved in the opt-in `test:installed-runtime` suite. Ordinary unit tests now exercise metadata classification and method scanning with a temporary, non-executable sample; this is not presented as real-runtime acceptance. Production source files are unchanged.

## Earlier development checks — 2026-10-20

The locally retained 1.0.2 delivery record reports:

- Windows scripted suite: **106/106** passing.
- Linux scripted suite: **106/106** passing.
- A bounded GOAT / native-profile real-runtime acceptance exercise: **17/17** checks passing, including host assertions on generated code.
- Small output budgets remained explicit; real output exhaustion produced `incomplete`; continuation reused a live process and preserved prior evidence hashes.

These are historical, environment-specific development checks. The original private evidence remains local. They do not prove all providers, all tasks, all installations, or current provider availability.

## Public-upload checks — 2026-10-21

Fresh installation, build and scripted-suite results are recorded in [PUBLICATION_CHECKS.json](PUBLICATION_CHECKS.json). GitHub Actions runs the scripted suite on Ubuntu with Node.js 24, without model credentials. Check the workflow for the commit you intend to use; the existence of workflow YAML alone is not evidence of a successful run.

Real model requests are not part of the public-upload checks. Model access, a separately configured DSH runtime, local baseline files for explicit profiles, and a suitable host boundary are prerequisites for repeating those exercises.

## What remains open

- Portable Windows defaults and Windows CI without the original D-drive convention.
- Broader harness/model/provider compatibility with reproducible tasks and acceptance criteria.
- Installation and runtime behavior on new machines and future DSH versions.
- Independent review, external-user feedback, and adoption metrics.
- Controlled measurements of speed, cost, and maintenance savings.
