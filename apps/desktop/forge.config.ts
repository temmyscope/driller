import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    // AD-3: packaging uses Electron Forge with auto-unpack-natives so any
    // native module (tree-sitter bindings, node-llama-cpp — added in later
    // stories) is unpacked from the asar correctly.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: { main: 'main/index.ts' },
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: { preload: 'preload/index.ts' },
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // The Graph Service subprocess (AD-1). It is not "main process"
          // code, but the plugin only distinguishes 'main' | 'preload'
          // build targets, and 'main' gets the right treatment here: a
          // plain Node/Electron-builtins-external CJS bundle, output
          // alongside main.js so `utilityProcess.fork` can find it at
          // `path.join(__dirname, 'graph-service.js')`.
          entry: { 'graph-service': '../../services/graph-service/index.ts' },
          config: 'vite.graph-service.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
