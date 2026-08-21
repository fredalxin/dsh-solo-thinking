# Optional DeepSeek Harness host patch

The plugin works on stock DSH `0.1.0-rc.6` through its full `头脑风暴` conversation view. The optional patch adds two Host capabilities used by the Solo-style right rail:

1. `conversation.details.aux`: an additive list slot above official Tool details.
2. `SessionStore.registerEventType(type)`: lifecycle-scoped registration for plugin persistence event vocabulary.

The patch was produced and tested against DeepSeek Harness commit:

```text
47f943859bef60e4160492346772ded9b24f765a
```

Apply it only to a clean checkout of that revision:

```bash
cd /path/to/deepseek-harness
git checkout 47f943859bef60e4160492346772ded9b24f765a
git apply --check /path/to/dsh-plugin-solo-thinking/patches/deepseek-harness-47f9438-solo-thinking.patch
git apply /path/to/dsh-plugin-solo-thinking/patches/deepseek-harness-47f9438-solo-thinking.patch

pnpm install
pnpm run build:lib:host
pnpm run typecheck:contracts-ready
```

Then install this plugin into the source checkout's Web profile and boot it:

```bash
pnpm dsh plugin --profile web add github:fredalxin/dsh-solo-thinking#v0.1.19
pnpm dsh --profile web
```

Do not force-apply the patch to another revision. Rebase it or use stock DSH's conversation tab until an equivalent API is available upstream.
