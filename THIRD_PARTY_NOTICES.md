# Third-party notices

The MIT license in this repository applies to the bridge's own source. It does not relicense external packages, DSH installations, or provider services.

Direct dependencies declared in the package manifests:

| Package | Declared version | Package license |
| --- | --- | --- |
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 |
| `zod` | 4.6.7 | MIT |
| `@modelcontextprotocol/client` (development) | 2.3.1 | Apache-2.0 |
| `@types/node` (development) | 24.19.2 | MIT |
| `typescript` (development) | 5.9.3 | Apache-2.0 |

Consult each installed package's license and the lockfile for its transitive dependencies. Dependency contents are not vendored in this source repository.

The optional adapter in `plugin/dsh-preset-sdk-server.mjs` imports and extends classes from a separately installed `@deepseek-ai` runtime. That runtime and its SDK packages are not included here. Obtain them through an authorized distribution and check their own license and compatibility before use or redistribution. The adapter does not grant rights to redistribute that runtime.

OpenAI, Codex, DeepSeek, and other product names identify interoperating products or services. Their use here does not imply endorsement or affiliation.
