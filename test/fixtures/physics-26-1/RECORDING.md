# MCCPhysicsTrace Recording Procedure (PaperMC 26.1.2 + MCC)

This directory holds **`MCCPhysicsTrace`** fixtures used as the oracle for
Property 8 (`mineflayer/test/physics_26_1.test.js` — physics-tick alignment
between mineflayer and the MCC reference implementation).

Each `*.json` here is a deterministic per-tick recording of
`(position, velocity, onGround, isSprinting, isSneaking)` produced by
**Minecraft-Console-Client (MCC)** running against a single-player
**PaperMC 26.1.2** world with a locked seed and disabled randomness.

> **CI never re-records.** Fixtures are checked into git as the test oracle
> and only refreshed when MCC's physics constants change
> (`MinecraftClient/Physics/PhysicsConsts.cs`). See
> `.kiro/specs/minecraft-26-1-protocol-and-velocity-support/design.md`
> sections "MCC 物理常量（对照表）" and "MCCPhysicsTrace（对照预言）".

---

## 0. Prerequisites

- Java 21+ (for PaperMC 26.1.2)
- .NET 8 SDK (for `dotnet run --project MinecraftClient`)
- A clean checkout of `Minecraft-Console-Client/` (the sibling repo in this
  workspace) — **read-only**, do not commit recording-only chatbots into it.
- `jq` 1.6+ for the NDJSON → JSON conversion step.

---

## 1. Deterministic PaperMC 26.1.2 server

Goal: a fully reproducible world where a given starting position and input
sequence produce byte-identical physics every run.

### 1.1 Layout

```
recording/
  papermc/
    paper-1.21.x.jar              # PaperMC 26.1.2 jar
    eula.txt                      # eula=true
    server.properties             # see 1.2
    bukkit.yml                    # see 1.3
    paper-global.yml              # see 1.4
    spigot.yml                    # see 1.5
```

### 1.2 `server.properties`

```properties
level-seed=42
level-type=minecraft\:flat
generate-structures=false
spawn-protection=0
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
gamemode=survival
difficulty=peaceful
hardcore=false
online-mode=false
view-distance=10
simulation-distance=10
allow-flight=false
enforce-secure-profile=false
enable-command-block=true
```

> The flat world type plus `level-seed=42` removes terrain variability; we
> still place test geometry (the 0.5-block step, water pools, etc.) via
> in-game `/setblock` from the recorder driver — see §3.

### 1.3 `bukkit.yml` — disable random ticks

```yaml
ticks-per:
  animal-spawns: 0
  monster-spawns: 0
  water-spawns: 0
  ambient-spawns: 0
  water-ambient-spawns: 0
  autosave: 0
```

### 1.4 `paper-global.yml` — kill all randomness sources

```yaml
unsupported-settings:
  allow-permanent-block-break-exploits: false
misc:
  fix-entity-position-desync: true
  load-permissions-yml-before-plugins: true
chunk-system:
  io-threads: 1
  worker-threads: 1
```

### 1.5 `spigot.yml` — random tick speed = 0

```yaml
world-settings:
  default:
    ticks-per:
      hopper-transfer: 8
      hopper-check: 1
    arrow-despawn-rate: 1200
    item-despawn-rate: 6000
    random-light-updates: false
    save-structure-info: true
    seed-feature: 42
```

Then **before recording any trace**, run these commands once on the server
console (or via MCC `/op`-ed account):

```
/gamerule randomTickSpeed 0
/gamerule doDaylightCycle false
/gamerule doWeatherCycle false
/gamerule doMobSpawning false
/gamerule doFireTick false
/gamerule mobGriefing false
/gamerule doInsomnia false
/gamerule doPatrolSpawning false
/gamerule doTraderSpawning false
/gamerule doImmediateRespawn true
/time set day
/weather clear
/difficulty peaceful
```

### 1.6 Boot

```bash
cd recording/papermc
java -Xms2G -Xmx2G -jar paper-1.21.x.jar nogui
```

Wait for `Done (...)! For help, type "help"`.

---

## 2. MCC sampler ChatBot (read-only, out-of-tree)

We **do not** modify the `Minecraft-Console-Client/` source tree.
The sampler is loaded via MCC's **scripts directory** (`Settings.cs` →
`AppFolder` / `--scripts`), which keeps recording artifacts out of git.

### 2.1 File: `recording/mcc-scripts/PhysicsSampler.cs`

```csharp
// SPDX-License-Identifier: 0BSD
// Read-only MCC ChatBot that emits one NDJSON line per physics tick.
// Loaded via:  --scripts=recording/mcc-scripts
using System;
using System.Globalization;
using System.IO;
using MinecraftClient;
using MinecraftClient.ChatBots;

public sealed class PhysicsSampler : ChatBot
{
    private long tick = 0;
    private readonly StreamWriter ndjson;
    private readonly string scenario;

    public PhysicsSampler()
    {
        scenario = Environment.GetEnvironmentVariable("MCC_TRACE_SCENARIO") ?? "unnamed";
        var outDir = Environment.GetEnvironmentVariable("MCC_TRACE_OUTDIR") ?? ".";
        Directory.CreateDirectory(outDir);
        ndjson = new StreamWriter(Path.Combine(outDir, $"{scenario}.ndjson"));
        ndjson.NewLine = "\n";
        ndjson.AutoFlush = true;
    }

    public override void Update()
    {
        // Update() is called once per MCC tick (~20 Hz).
        var p   = GetCurrentLocation();           // double x,y,z
        var v   = GetEntityVelocity(GetPlayerEntityID()); // double x,y,z
        var og  = IsOnGround();
        var spr = IsSprinting();
        var sne = IsSneaking();

        ndjson.WriteLine(string.Format(
            CultureInfo.InvariantCulture,
            "{{\"tick\":{0},\"position\":{{\"x\":{1:R},\"y\":{2:R},\"z\":{3:R}}},"
          + "\"velocity\":{{\"x\":{4:R},\"y\":{5:R},\"z\":{6:R}}},"
          + "\"onGround\":{7},\"isSprinting\":{8},\"isSneaking\":{9}}}",
            tick,
            p.X, p.Y, p.Z,
            v.X, v.Y, v.Z,
            og.ToString().ToLowerInvariant(),
            spr.ToString().ToLowerInvariant(),
            sne.ToString().ToLowerInvariant()));
        tick++;
    }
}
```

> The ChatBot uses only public MCC APIs (`GetCurrentLocation`,
> `GetEntityVelocity`, `IsOnGround`, `IsSprinting`, `IsSneaking`). It does
> **not** mutate physics state; its only side-effect is appending to NDJSON.

### 2.2 Input driver: `recording/mcc-scripts/<scenario>.txt`

Each scenario carries a sibling text file fed via MCC `--script` containing
the per-tick input commands (`/move forward`, `/look`, `/sprint`, etc.).
The exact MCC chat-script DSL is documented in
`Minecraft-Console-Client/MinecraftClient/ChatBots/Script.cs`.

---

## 3. Run a single recording

```bash
cd Minecraft-Console-Client
export MCC_TRACE_SCENARIO=flat_walk_a
export MCC_TRACE_OUTDIR=../recording/out
dotnet run --project MinecraftClient -- \
    --server=127.0.0.1:25565 \
    --username=physbot \
    --uuid="00000000-0000-0000-0000-00000000beef" \
    --scripts=../recording/mcc-scripts \
    --script=../recording/mcc-scripts/flat_walk_a.txt \
    --chatbot=PhysicsSampler
```

MCC will:

1. Connect to PaperMC 26.1.2 in offline mode (`enforce-secure-profile=false`).
2. Spawn `physbot` at world spawn.
3. Run `flat_walk_a.txt` to drive scripted inputs.
4. Append one NDJSON line per tick to `recording/out/flat_walk_a.ndjson`.

Stop the bot with `Ctrl-C` once the script finishes (or after the desired
tick count — see §5 for trace length cap).

---

## 4. NDJSON → MCCPhysicsTrace JSON

```bash
node recording/scripts/ndjson-to-trace.js \
     --in=recording/out/flat_walk_a.ndjson \
     --inputs=recording/mcc-scripts/flat_walk_a.inputs.json \
     --seed=42 \
     --name=flat_walk_a \
     --out=mineflayer/test/fixtures/physics-26-1/flat_walk_a.json
```

The converter (`recording/scripts/ndjson-to-trace.js`, kept in the recording
sandbox — not in this directory) emits the canonical schema:

```jsonc
{
  "name": "<scenario>",
  "worldSeed": "42",
  "startState": {
    "position": { "x": <number>, "y": <number>, "z": <number> },
    "velocity": { "x": <number>, "y": <number>, "z": <number> },
    "yaw":   <number>,
    "pitch": <number>,
    "onGround": <bool>
  },
  "inputs": [
    { "tick": 0, "forward": <bool>, "back": <bool>,
      "left": <bool>, "right": <bool>,
      "jump": <bool>, "sprint": <bool>, "sneak": <bool> },
    /* ... */
  ],
  "ticks": [
    { "tick": 0,
      "position": { "x": <number>, "y": <number>, "z": <number> },
      "velocity": { "x": <number>, "y": <number>, "z": <number> },
      "onGround": <bool>, "isSprinting": <bool>, "isSneaking": <bool> },
    /* ... */
  ]
}
```

Notes:

- `worldSeed` is a **string** (JSON cannot represent `bigint` literally).
- `inputs.length === ticks.length`, indexed by `tick`.
- `ticks[i]` is the player state **after** tick `i` is processed.
- A `Float64` round-trip through `JSON.stringify` / `JSON.parse` preserves
  bit-identical doubles, which is what the `Position_Epsilon = 0.001`
  comparison in P8 relies on.

---

## 5. Required fixture pool

P8 (`mineflayer/test/physics_26_1.test.js`) reads every `*.json` in this
directory. Each scenario must have **≥ 2 fixtures** with **different** initial
states (e.g. different `startState.position` and / or `yaw`), and **each
trace must be ≤ 200 ticks** (Requirement 12.7).

| Scenario           | What it covers (Requirement)            | Suggested file names                       |
| ------------------ | --------------------------------------- | ------------------------------------------ |
| `flat_walk`        | walking straight on flat ground (12.1)  | `flat_walk_a.json`, `flat_walk_b.json`     |
| `half_step`        | walking up a 0.5-block step (12.3)      | `half_step_a.json`, `half_step_b.json`     |
| `sprint`           | sprinting on flat ground (12.4)         | `sprint_a.json`, `sprint_b.json`           |
| `jump_no_boost`    | plain jump, `jumpBoost=0` (12.5)        | `jump_no_boost_a.json`, `..._b.json`       |
| `jump_boost_1`     | jump with `jumpBoost=1` (12.5)          | `jump_boost_1_a.json`, `..._b.json`        |
| `jump_boost_2`     | jump with `jumpBoost=2` (12.5)          | `jump_boost_2_a.json`, `..._b.json`        |
| `water_immersion`  | walking into water (12.6)               | `water_immersion_a.json`, `..._b.json`     |
| `water_jump`       | jumping while in water (12.6)           | `water_jump_a.json`, `water_jump_b.json`   |
| `sneak`            | sneaking on flat ground (12.1)          | `sneak_a.json`, `sneak_b.json`             |
| `air_turn`         | turning yaw mid-air (12.1, 12.2)        | `air_turn_a.json`, `air_turn_b.json`       |

Geometry preparation (run once per server boot, before recording the
relevant scenarios):

```
# half-step pad at x=20 z=0
/setblock 19 64 0 minecraft:stone replace
/setblock 20 64 0 minecraft:stone_slab[type=bottom] replace

# water pool at x=40 z=0..3
/fill 39 63 -1 42 63 4 minecraft:stone replace
/fill 40 64 0 41 65 3 minecraft:water replace

# jump_boost potions are given via /effect to the bot account before recording:
/effect give physbot minecraft:jump_boost 60 0 true   # jump_boost_1 (amplifier 0 = level 1)
/effect give physbot minecraft:jump_boost 60 1 true   # jump_boost_2
```

---

## 6. Refresh policy

- **Local re-record only.** CI does not regenerate fixtures.
- Re-record when:
  - MCC's `Physics/PhysicsConsts.cs` changes any of
    `StepHeight`, `BaseJumpPower`, `SprintJumpHorizontalBoost`,
    `WaterSlowDown`, `WaterSprintSlowDown`, `WaterBaseSpeed`,
    `DolphinsGraceSlowDown`.
  - PaperMC ships a 26.x physics-affecting bugfix.
- Always re-record **all 20 fixtures** (`scenario × {a, b}`) in the same
  PaperMC + MCC pair to keep them mutually consistent.
- Commit the JSON files only — never commit the NDJSON dumps,
  `recording/papermc/world/`, or `recording/mcc-scripts/`.

---

## 7. Sanity check before committing

```bash
# fixture-pool integrity
node -e "const fs=require('fs');const path=require('path');\
const dir='mineflayer/test/fixtures/physics-26-1';\
for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){\
  const t=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));\
  if(t.ticks.length>200)throw new Error(f+': trace too long');\
  if(t.inputs.length!==t.ticks.length)throw new Error(f+': inputs/ticks length mismatch');\
}console.log('ok');"
```

Then run the full P8 property suite:

```bash
cd mineflayer
npx mocha test/physics_26_1.test.js --timeout 60000
```

---

## 8. Current state of this directory

The fixtures shipped today (`flat_walk_a.json`, `flat_walk_b.json`) are
**synthetic placeholders** carrying `"_placeholder": true` and a
`"_note"` field. They exist so the P8 test harness can be wired up
end-to-end before a live PaperMC + MCC recording session is performed.
**Replace each placeholder with a real MCC trace before relying on the P8
results for any correctness claim.**
