/* eslint-env mocha */
'use strict'

// Regression test: legacy minecraft versions still resolve to their own
// data/pc/<version>/ directories and never accidentally pick up data/pc/26.1/.
//
// Adding 26.1 to minecraft-data's dataPaths.json must not perturb any older
// release. This test pins that contract for two representative legacy
// versions and asserts:
//   1. minecraft-data(version) resolves without throwing.
//   2. The resolved protocol number matches the expected wire id.
//   3. The .protocol document still exposes play.toClient / play.toServer
//      and configuration.toClient / configuration.toServer (the four packet
//      tables NMP dispatches over).
//   4. None of the data file paths registered for the legacy version point
//      into pc/26.1/, and the underlying files exist on disk where dataPaths
//      claims they live.
//
// This is a unit / regression test - no docker, no real bot, no network. It
// runs as part of mineflayer's normal `npm test` (mocha) suite.
//
// Validates: Requirements 14.1, 14.2, 14.3, 14.4

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const minecraftData = require('minecraft-data')

// Locate the on-disk minecraft-data data root once, so individual cases can
// verify that the paths registered in dataPaths.json actually exist.
//
// minecraft-data ships its data tree under
//   <pkg-root>/minecraft-data/data/
// regardless of whether it was installed via npm or vendored.
const minecraftDataPkgRoot = path.dirname(require.resolve('minecraft-data/package.json'))
const minecraftDataRoot = path.join(minecraftDataPkgRoot, 'minecraft-data', 'data')
const dataPaths = JSON.parse(
  fs.readFileSync(path.join(minecraftDataRoot, 'dataPaths.json'), 'utf8')
)

// Legacy versions to pin. The pair below covers a 1.20.x release (oldest
// still in active mineflayer support) and the immediate predecessor of 26.1
// (1.21.11), which is the most likely victim of an accidental 26.1 path
// regression.
const cases = [
  { version: '1.21.11', expectedProtocol: 774 },
  { version: '1.20.4', expectedProtocol: 765 }
]

describe('minecraft-data legacy version resolution (Requirement 14.1-14.4 regression)', function () {
  for (const { version, expectedProtocol } of cases) {
    describe(`version ${version}`, function () {
      it('resolves via require(minecraft-data)(version) without throwing', function () {
        // If 26.1 had broken the version registry, this call would throw or
        // return undefined for legacy versions.
        const md = minecraftData(version)
        assert.ok(md, `minecraft-data('${version}') must return an instance`)
        assert.ok(md.version, `minecraft-data('${version}').version must be populated`)
      })

      it(`reports protocol number ${expectedProtocol} on .version.version`, function () {
        const md = minecraftData(version)
        assert.strictEqual(
          md.version.version,
          expectedProtocol,
          `expected protocol ${expectedProtocol} for ${version}, got ${md.version.version}`
        )
        // minecraftVersion should still match the requested version - this
        // is the human-readable id used by NMP / mineflayer to drive
        // version-specific feature flags.
        assert.strictEqual(md.version.minecraftVersion, version)
      })

      it('exposes a .protocol document with play and configuration packet tables', function () {
        const md = minecraftData(version)
        const protocol = md.protocol
        assert.ok(protocol, '.protocol must be present')
        assert.ok(protocol.play, '.protocol.play must be present')
        assert.ok(protocol.play.toClient, '.protocol.play.toClient must be present')
        assert.ok(protocol.play.toServer, '.protocol.play.toServer must be present')
        assert.ok(protocol.configuration, '.protocol.configuration must be present')
        assert.ok(
          protocol.configuration.toClient,
          '.protocol.configuration.toClient must be present'
        )
        assert.ok(
          protocol.configuration.toServer,
          '.protocol.configuration.toServer must be present'
        )
      })

      it('never resolves any data file from pc/26.1/', function () {
        // The whole point of this regression test: if anyone ever points a
        // legacy version's dataPaths entry at pc/26.1/ (by mistake or via
        // copy-paste during the 26.1 rollout), this assertion fails.
        const paths = dataPaths.pc[version]
        assert.ok(paths, `dataPaths.pc['${version}'] must exist`)

        for (const [key, relPath] of Object.entries(paths)) {
          assert.notStrictEqual(
            relPath,
            'pc/26.1',
            `${version}.${key} must not point to pc/26.1 (got '${relPath}')`
          )
          assert.ok(
            !relPath.startsWith('pc/26.1/'),
            `${version}.${key} must not be rooted under pc/26.1/ (got '${relPath}')`
          )
        }
      })

      it('has on-disk version.json and protocol.json files where dataPaths says', function () {
        // Each minecraft-data version aggregates files from one or more
        // pc/<x.y[.z]> directories - the protocol document, in particular,
        // is sometimes shared between minor versions (e.g. 1.20.4 reads
        // protocol.json from pc/1.20.3). We verify both that the registered
        // path is non-empty and that the file actually exists on disk so
        // that a missing or misnamed legacy directory is caught early.
        const paths = dataPaths.pc[version]

        const versionDir = paths.version
        assert.ok(versionDir, `${version} must register a 'version' path`)
        const versionFile = path.join(minecraftDataRoot, versionDir, 'version.json')
        assert.ok(
          fs.existsSync(versionFile),
          `expected version.json at ${versionFile}`
        )

        const protocolDir = paths.protocol
        assert.ok(protocolDir, `${version} must register a 'protocol' path`)
        const protocolFile = path.join(minecraftDataRoot, protocolDir, 'protocol.json')
        assert.ok(
          fs.existsSync(protocolFile),
          `expected protocol.json at ${protocolFile}`
        )

        // And neither resolved directory is pc/26.1.
        assert.notStrictEqual(versionDir, 'pc/26.1')
        assert.notStrictEqual(protocolDir, 'pc/26.1')
      })
    })
  }
})
