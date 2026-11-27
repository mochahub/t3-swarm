# mochahub/skills

A collection of reusable [Agent Skills](https://agentskills.io) by [MochaHub](https://github.com/mochahub), installable individually with [`npx skills`](https://skills.sh).

## Installation

Browse available skills in this repository:

```bash
npx skills@latest add mochahub/skills --list
```

Install specific skills globally with `--skill`:

```bash
# Example: install t3-swarm on your chosen Coordinator harness
npx skills@latest add mochahub/skills --skill t3-swarm --skill t3-swarm-setup -g -a antigravity --copy
```

See each skill's documentation for harness-specific flags and setup steps.

## Skills

| Skill | Description | Docs |
| :--- | :--- | :--- |
| **[`t3-swarm`](skills/t3-swarm/SKILL.md)** | Three-tier multi-provider orchestration for [T3 Code](https://t3.codes) (Coordinator → Failover Lead → Tiered Worker Pool) with quota weighting, multi-workstream boards, remote boxes, and an optional live view. | [Guide](docs/t3-swarm/README.md) |
| **[`t3-swarm-setup`](skills/t3-swarm-setup/SKILL.md)** | Interactive auto-discovery & setup wizard for `t3-swarm`. Inspects enabled T3 Code providers and writes `~/.t3/swarm/config.json`. | [Guide](docs/t3-swarm/README.md#1-auto-configure-from-your-enabled-t3-providers) |

## Repository Layout

```text
.
├── skills/
│   └── <skill-name>/       # Lean, installable skill (SKILL.md, references/, scripts/)
└── docs/
    └── <skill-name>/       # Extended documentation, architecture diagrams, and media
```

Large images and walkthrough docs live under `docs/<skill-name>/` so `npx skills` installs stay small and fast.

## License

[MIT](LICENSE)
