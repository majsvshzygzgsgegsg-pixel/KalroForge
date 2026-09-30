# Security

ForgePilot executes model-requested tools on your machine. Treat every prompt, model response,
and repository you open as untrusted input.

- Keep the default `on-risk` approval policy.
- Use `--dry-run` when evaluating a new model or prompt.
- Scope `--workspace` to the smallest useful directory.
- Never commit `.env` or API keys.
- Review shell commands before approving them.
- Treat third-party plugins as trusted code after enablement. ForgePilot validates manifests,
  provenance, permissions, size, symlinks, lifecycle scripts, and tool declarations, but JavaScript
  plugins still run in the ForgePilot process and are not an OS sandbox.
- Discovery results are untrusted metadata. `tools search` never installs or executes them.
- Installed plugins start disabled. Inspect their source before running `tools enable`.
- Browser navigation uses the network; clicks and typing are high-risk and require approval under
  the default policy.
- The web app binds to loopback only and rejects non-local Host/Origin values. It is not designed for
  internet exposure; use a separately audited authentication proxy before any future remote access.

Please report vulnerabilities privately through GitHub's security-advisory feature. Do not include
live credentials, private source code, or other sensitive data in a report.
