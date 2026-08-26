/* eslint-env mocha */

// Unit tests for `recordWireBytes` (task 1.4 of mineflayer-26-1-physics-and-action-bugs).
//
// Validates: Requirements 3.1, 3.7
// Preservation: P₁ (旧协议字节等价快照基础设施), P₇ (非缺陷输入等价基线基础设施)
//
// We exercise the helper with a hermetic temp `snapshotsDir` so the real
// `mineflayer/test/snapshots/preservation/` tree is never touched by the
// unit tests. Cases:
//
//   1. Update mode writes the hex to <packetName>.<protocolVersion>.bytes
//      and creates the parent directory if it does not exist.
//   2. Verify mode succeeds when the snapshot matches.
//   3. Verify mode fails (AssertionError) when the snapshot differs, with
//      a helpful message that mentions the packet / protocol / path.
//   4. Verify mode fails (Error) when the snapshot is missing, mentioning
//      the UPDATE_SNAPSHOTS hint.
//   5. Argument validation: Buffer required, protocolVersion must be a
//      positive integer, packetName must be a non-empty string with no
//      path separators.
//   6. Auto-detect: env UPDATE_SNAPSHOTS=1 → update; argv '--update-snapshots'
//      → update; otherwise → verify. We drive `_isUpdateSnapshotsRequested`
//      directly since temporarily mutating process.env / process.argv inside
//      a parallel test run would race.
//
// MAIN PATH SAFETY: the test never sets UPDATE_SNAPSHOTS=1 on its own
// process.env (it forces `mode: 'update'` on each call instead), so even if
// UPDATE_SNAPSHOTS leaks into the env from outside, the real snapshots
// directory stays untouched.

const fs = require('fs')
const path = require('path')
const os = require('os')
const assert = require('assert')

const {
  recordWireBytes,
  DEFAULT_SNAPSHOTS_DIR,
  _isUpdateSnapshotsRequested
} = require('./_fixture26_1.js')

function makeTempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recordWireBytes-'))
}

function cleanupTempDir (dir) {
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_) { /* best effort */ }
}

describe('_fixture26_1.recordWireBytes', () => {
  let tmpDir

  beforeEach(() => { tmpDir = makeTempDir() })
  afterEach(() => { cleanupTempDir(tmpDir); tmpDir = null })

  describe('update mode', () => {
    it('writes hex to <packetName>.<protocolVersion>.bytes', () => {
      const rawBytes = Buffer.from([0x00, 0x07, 0x80, 0xff, 0x10, 0x10])
      const result = recordWireBytes({
        protocolVersion: 769,
        packetName: 'block_dig',
        rawBytes,
        snapshotsDir: tmpDir,
        mode: 'update'
      })

      assert.strictEqual(result.mode, 'update')
      assert.strictEqual(result.action, 'wrote')
      assert.strictEqual(result.hex, '000780ff1010')

      const expectedPath = path.join(tmpDir, 'block_dig.769.bytes')
      assert.strictEqual(result.snapshotPath, expectedPath)
      assert.ok(fs.existsSync(expectedPath), 'snapshot file should exist after update')
      // We allow a trailing newline but not extra content.
      assert.strictEqual(
        fs.readFileSync(expectedPath, 'utf8').trim(),
        '000780ff1010'
      )
    })

    it('creates the snapshots directory recursively if missing', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'preservation')
      assert.ok(!fs.existsSync(nestedDir))

      recordWireBytes({
        protocolVersion: 765,
        packetName: 'flying',
        rawBytes: Buffer.from([0x01]),
        snapshotsDir: nestedDir,
        mode: 'update'
      })

      assert.ok(fs.existsSync(path.join(nestedDir, 'flying.765.bytes')))
    })

    it('overwrites a previous snapshot when update mode is requested again', () => {
      const target = path.join(tmpDir, 'look.769.bytes')
      fs.writeFileSync(target, 'deadbeef\n')

      const newBytes = Buffer.from([0x12, 0x34])
      recordWireBytes({
        protocolVersion: 769,
        packetName: 'look',
        rawBytes: newBytes,
        snapshotsDir: tmpDir,
        mode: 'update'
      })

      assert.strictEqual(fs.readFileSync(target, 'utf8').trim(), '1234')
    })
  })

  describe('verify mode', () => {
    it('matches when actual hex == snapshot hex', () => {
      const target = path.join(tmpDir, 'block_place.769.bytes')
      fs.writeFileSync(target, 'cafebabe\n')

      const result = recordWireBytes({
        protocolVersion: 769,
        packetName: 'block_place',
        rawBytes: Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
        snapshotsDir: tmpDir,
        mode: 'verify'
      })

      assert.strictEqual(result.mode, 'verify')
      assert.strictEqual(result.action, 'matched')
      assert.strictEqual(result.hex, 'cafebabe')
    })

    it('tolerates trailing whitespace / newlines in the snapshot file', () => {
      const target = path.join(tmpDir, 'position.765.bytes')
      fs.writeFileSync(target, '  aabbcc\r\n\n')

      assert.doesNotThrow(() => {
        recordWireBytes({
          protocolVersion: 765,
          packetName: 'position',
          rawBytes: Buffer.from([0xaa, 0xbb, 0xcc]),
          snapshotsDir: tmpDir,
          mode: 'verify'
        })
      })
    })

    it('throws AssertionError on mismatch with packet / protocol / path in the message', () => {
      const target = path.join(tmpDir, 'block_dig.769.bytes')
      fs.writeFileSync(target, '00\n')

      let caught = null
      try {
        recordWireBytes({
          protocolVersion: 769,
          packetName: 'block_dig',
          rawBytes: Buffer.from([0xff]),
          snapshotsDir: tmpDir,
          mode: 'verify'
        })
      } catch (err) {
        caught = err
      }
      assert.ok(caught, 'expected an error to be thrown on mismatch')
      assert.ok(caught instanceof assert.AssertionError, 'expected AssertionError')
      assert.match(caught.message, /block_dig/)
      assert.match(caught.message, /769/)
      assert.match(caught.message, /snapshot path:/)
      assert.match(caught.message, /UPDATE_SNAPSHOTS/)
      assert.strictEqual(caught.actual, 'ff')
      assert.strictEqual(caught.expected, '00')
    })

    it('throws Error("snapshot missing") with UPDATE_SNAPSHOTS hint when the file is absent', () => {
      let caught = null
      try {
        recordWireBytes({
          protocolVersion: 775,
          packetName: 'use_item_on',
          rawBytes: Buffer.from([0x00]),
          snapshotsDir: tmpDir,
          mode: 'verify'
        })
      } catch (err) {
        caught = err
      }
      assert.ok(caught, 'expected an error to be thrown when snapshot is missing')
      assert.match(caught.message, /snapshot missing/)
      assert.match(caught.message, /use_item_on/)
      assert.match(caught.message, /775/)
      assert.match(caught.message, /UPDATE_SNAPSHOTS/)
    })

    it('does not write any file in verify mode, even on mismatch', () => {
      const target = path.join(tmpDir, 'block_dig.769.bytes')
      fs.writeFileSync(target, '00\n')
      const beforeMtime = fs.statSync(target).mtimeMs

      try {
        recordWireBytes({
          protocolVersion: 769,
          packetName: 'block_dig',
          rawBytes: Buffer.from([0xff]),
          snapshotsDir: tmpDir,
          mode: 'verify'
        })
      } catch (_) { /* expected */ }

      const afterMtime = fs.statSync(target).mtimeMs
      assert.strictEqual(beforeMtime, afterMtime, 'verify-mode mismatch must not rewrite the snapshot')
    })
  })

  describe('argument validation', () => {
    const validBase = {
      protocolVersion: 769,
      packetName: 'flying',
      rawBytes: Buffer.from([0x00]),
      mode: 'update'
    }
    function withSnapshotsDir (overrides, dir) {
      return Object.assign({}, validBase, overrides, { snapshotsDir: dir })
    }

    it('rejects non-Buffer rawBytes', () => {
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ rawBytes: '00ff' }, tmpDir)),
        /rawBytes must be a Buffer/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ rawBytes: null }, tmpDir)),
        /rawBytes must be a Buffer/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ rawBytes: [0, 1] }, tmpDir)),
        /rawBytes must be a Buffer/
      )
    })

    it('rejects non-integer / non-positive protocolVersion', () => {
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ protocolVersion: '769' }, tmpDir)),
        /protocolVersion must be a positive integer/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ protocolVersion: 0 }, tmpDir)),
        /protocolVersion must be a positive integer/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ protocolVersion: 1.5 }, tmpDir)),
        /protocolVersion must be a positive integer/
      )
    })

    it('rejects empty / non-string packetName', () => {
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ packetName: '' }, tmpDir)),
        /packetName must be a non-empty string/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ packetName: 12 }, tmpDir)),
        /packetName must be a non-empty string/
      )
    })

    it('rejects packetName containing path separators or ".."', () => {
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ packetName: '../escape' }, tmpDir)),
        /must not contain path separators/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ packetName: 'foo/bar' }, tmpDir)),
        /must not contain path separators/
      )
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ packetName: 'foo\\bar' }, tmpDir)),
        /must not contain path separators/
      )
    })

    it('rejects an invalid mode override', () => {
      assert.throws(
        () => recordWireBytes(withSnapshotsDir({ mode: 'rewrite-everything' }, tmpDir)),
        /mode must be 'update' \| 'verify' \| 'auto'/
      )
    })

    it('rejects a missing options object entirely', () => {
      assert.throws(() => recordWireBytes(), /options must be an object/)
      assert.throws(() => recordWireBytes(null), /options must be an object/)
    })
  })

  describe('auto-detect of update vs verify mode', () => {
    // We mutate process.env / process.argv in-place and restore them. mocha
    // runs tests serially within a single file by default, so this is safe.
    const ENV_KEY = 'UPDATE_SNAPSHOTS'
    let savedEnv, savedArgv

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY]
      savedArgv = process.argv
    })
    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY]
      else process.env[ENV_KEY] = savedEnv
      process.argv = savedArgv
    })

    it('returns false when neither env nor argv is set', () => {
      delete process.env[ENV_KEY]
      process.argv = ['node', 'mocha']
      assert.strictEqual(_isUpdateSnapshotsRequested(), false)
    })

    it('returns true when UPDATE_SNAPSHOTS=1', () => {
      process.env[ENV_KEY] = '1'
      process.argv = ['node', 'mocha']
      assert.strictEqual(_isUpdateSnapshotsRequested(), true)
    })

    it('returns false when UPDATE_SNAPSHOTS=0 or empty', () => {
      process.env[ENV_KEY] = '0'
      process.argv = ['node', 'mocha']
      assert.strictEqual(_isUpdateSnapshotsRequested(), false)
      process.env[ENV_KEY] = ''
      assert.strictEqual(_isUpdateSnapshotsRequested(), false)
    })

    it('returns true when argv contains --update-snapshots', () => {
      delete process.env[ENV_KEY]
      process.argv = ['node', 'mocha', '--update-snapshots']
      assert.strictEqual(_isUpdateSnapshotsRequested(), true)
    })

    it('honours --update-snapshots=1 and rejects --update-snapshots=0', () => {
      delete process.env[ENV_KEY]
      process.argv = ['node', 'mocha', '--update-snapshots=1']
      assert.strictEqual(_isUpdateSnapshotsRequested(), true)
      process.argv = ['node', 'mocha', '--update-snapshots=0']
      assert.strictEqual(_isUpdateSnapshotsRequested(), false)
      process.argv = ['node', 'mocha', '--update-snapshots=false']
      assert.strictEqual(_isUpdateSnapshotsRequested(), false)
    })
  })

  describe('default snapshot path', () => {
    it('points at mineflayer/test/snapshots/preservation/', () => {
      // Sanity check that DEFAULT_SNAPSHOTS_DIR resolves where the spec
      // expects, so when callers omit `snapshotsDir` they hit the right tree.
      assert.match(
        DEFAULT_SNAPSHOTS_DIR.replace(/\\/g, '/'),
        /mineflayer\/test\/snapshots\/preservation$/
      )
    })
  })
})
