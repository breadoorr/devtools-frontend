# CSS to Source frontend

The `css-to-source` branch contains the DevTools frontend changes used by the JetBrains CSS to Source plugin.

The branch is based on Chromium DevTools Frontend revision `c150ef91fa6f3f904d2e11e5c4a2118933ed994f`.

## Build

Use a synchronized DevTools checkout with `depot_tools` available on `PATH`:

```shell
mkdir -p out/Release
echo 'is_official_build=true' > out/Release/args.gn
gn gen out/Release
autoninja -C out/Release
node scripts/build/css_to_source/package_browser_assets.mjs
```

The plugin-ready archive is written to `out/css-to-source-devtools-frontend.zip`. Copy that archive to
`src/main/resources/server/bin/css-to-source-devtools-frontend.zip` in the plugin repository.
