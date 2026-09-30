# KairoForge

English | [中文](README.zh.md)

KairoForge is a local-first AI agent development workspace built from the open-source
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) project. It keeps the
upstream `dsh` runtime and safety model while adding an original product identity and a
focused path toward visual orchestration, team supervision, memory controls, evaluation,
voice, security, and installable desktop-quality Web use.

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

<a id="run-from-source"></a>

### Run KairoForge from source

To run from a repository checkout:

```sh
git clone https://github.com/majsvshzygzgsgegsg-pixel/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run kairoforge
```

`pnpm run kairoforge` builds the KairoForge profile, opens the Web app, and keeps rebuilding
client bundles while you edit the source. The equivalent short command is `make kairoforge`.

Pass Web options after the command, for example `pnpm run kairoforge --no-open --port 3081`
or `make kairoforge ARGS='--no-open --port 3081'`. `pnpm run source:web` and
`make source-web` remain aliases. Keep the command running while you edit the app; press
`Ctrl-C` to stop it.

See the [KairoForge upgrade blueprint](docs/kairoforge-upgrades.md) for the implementation
map and the boundaries between shipped, experimental, and planned capabilities.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run kairoforge` and `make kairoforge` build, serve, and rebuild the branded client on
source edits in one terminal. `pnpm run dev:web` remains the neutral upstream development
entry point. `make help` lists the matching Make targets for Web and Desktop.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
