# Creatures: design

Status (Nov 18, 2026): steps 1 and 2 are built. They were written test-first: `game/tools/creatures_test.js` came
first (18 tests, all failing), then the code, and it's now part of `npm test`.

Decisions taken from the review questions:
- The first animal is called **Mossback**.
- A dead animal stays dead, and the Animals panel offers **Release another grazer**.
- The tool that drops animals waits for step 3.

The playtest added two rules, each with a test:
- A species can't avoid what it eats.
- When a release finds fewer tiles an animal can stand on than it asked for, "What it does" says how many
  really landed.

## The idea

Glomus gets animals that try to survive on their own. The player can't steer them. The only way to help, or harm,
is to shape their world with whims and tools. That turns "pointless but cool" into a loop with a stake:

> a drought → the animal is thirsty → I dig a channel → it drinks → my fire from earlier is spreading toward it…

There are no rules about how to play. The same simulation supports two styles, and the page shows both scores:

- **Light touch:** keep it thriving with as few whims as possible.
- **Heavy hand:** engineer a paradise; the score is how well it thrives.

## Build order

| step | what | why this order |
|---|---|---|
| **1** | One built-in animal, with needs, senses, moving and dying, plus scores, a legend and a hover readout | Tests whether an animal changes how people play. Small enough to finish in one session. |
| **2** | Species as data; whims can invent species and release animals | The built-in animal is already written as data (like Nature in threads), so this mostly needs validation, an explanation line and the prompt. |
| 3 | Groups (herd, pack), breeding, one species eating another | Populations and food chains come out of the same rules, with no extra mode to choose. |
| 4 | A camera, then bigger and endless land | The most expensive step and separate from animals. A zoomable larger map comes first, to test the feel before chunked generation. |

Steps 3 and 4 are sketched at the end. Only steps 1 and 2 are specified here and tested.

## The key decision: the first animal is data

The built-in animal is defined in the same species format that whims will use. If it were hard-coded, "make your own
animals" would mean a rewrite. Written as data, it's one more species in the list. Nature already works this way:
it's written in threads, like any whim.

## Species (step 2's format, used by step 1's built-in animal)

```json
{
  "name": "grazer",
  "look": {"color": "#e8d27a", "pattern": "dot"},
  "eats": ["meadow"],
  "avoids": ["snow"],
  "wades": 0.3,
  "climbs": 1.5,
  "speed": 1,
  "thirst": 120,
  "hunger": 240
}
```

| field | meaning | allowed | default |
|---|---|---|---|
| `name` | lowercase, 1–20 letters; its own namespace, separate from materials | unique among species | (required) |
| `look.color` | `#rrggbb` | | (required) |
| `look.pattern` | how its glyph is drawn: a filled dot, a ring, a stripe, a diamond or a cross | `dot` `ring` `stripe` `diamond` `cross` | `dot` |
| `eats` | materials it feeds on | known materials, 1–3 | (required) |
| `avoids` | materials it won't step on and flees from | known materials, 0–3 | `[]` |
| `wades` | deepest water it will walk into, in metres | 0–2 | 0.3 |
| `climbs` | biggest height step between neighbouring tiles it can take, in metres | 0.5–5 | 1.5 |
| `speed` | tiles per second | 0.2–3 | 1 |
| `thirst` | seconds from fully watered to dying of thirst | 30–1200 | 120 |
| `hunger` | seconds from full to dying of hunger | 30–1200 | 240 |

Every animal drinks. The world has one kind of water, so there's no `drinks` field. At most 2 species per plan,
and 8 in the world.

## Animals (instances)

`world.creatures` holds animals:

```json
{"id": 1, "species": "grazer", "name": "Mossback", "x": 40.5, "y": 30.5, "thirst": 0.8, "hunger": 0.9,
 "state": "seeking water", "born": 0, "skein": 1, "thriving": 312, "whimsAtBirth": 0}
```

- `thirst` and `hunger` are 1 when satisfied and 0 when empty.
- The animal dies when either need reaches 0.
- Its position is a real number, so it moves smoothly, but it stands on one tile at a time.
- A dead animal stays on the map for 30 s as a faded marker with its cause of death, then disappears.

**Randomness.** Animals draw from their own random stream, `crng`, which is saved with the world. They never touch
the weather stream (`wrng`). The world's `rng` is the exception: an animal changes the ground (eating meadow), so
the meadow threads' random draws can differ. That's fine and expected.

## Behaviour (each tick, decisions once a second)

**Needs.** Each tick, thirst drops by `DT / thirst` and hunger by `DT / hunger`.

**Walkable tiles.** A tile is walkable when all of these hold:
- it's on the map;
- its water is no deeper than `wades`;
- its material isn't in `avoids`;
- the height step from the current tile is no more than `climbs`.

**Senses.** The animal sees tiles within 12 tiles. It doesn't know what's beyond that.

**Decisions, in priority order, once a second:**

1. **Flee.** If its tile isn't walkable (flooded deeper than `wades`, or painted with an avoided material), it heads
   for the nearest walkable tile. Its state is "fleeing".
2. **Drink.** If thirst is below 0.5, it heads for the nearest walkable tile next to water at least 0.05 m deep.
   - When it's there, it drinks: thirst refills to 1 over about 5 s. Its state is "drinking".
   - On the way, its state is "seeking water".
3. **Eat.** If hunger is below 0.5, it heads for the nearest walkable food tile (one of `eats`).
   - When it's there, it eats: hunger refills over about 6 s. Its state is "eating".
   - After 3 s of eating, the tile becomes soil, so food runs out where it grazes. Nature regrows meadow next to
     water, which is a tiny ecosystem for free.
4. **Wander.** Otherwise it picks a nearby walkable tile, at random from `crng`, and walks there. Its state is
   "wandering".

When it needs something it can't see, it explores: it picks a goal 12 tiles away in a random direction. Its state
is "searching for water" or "searching for food".

**Movement.**
- Each tick it moves `speed × DT` toward its goal.
- Its route is greedy. Of the 8 neighbouring tiles, it takes the walkable one that most reduces the distance to its
  goal.
- If none does, the animal is stuck and picks a new goal at the next decision.
- No pathfinding beyond that: for now, a lake or cliff between the animal and its goal makes it go around or give up.

**Dying.** An animal dies of:
- **thirst or hunger:** that need reaches 0;
- **drowning:** 5 s in water deeper than `wades + 1`;
- **one of its `avoids` materials:** 5 s standing on it. This covers fire.

The cause is recorded as `diedOf`.

## Where animals come from

- **The world's first animal.** `makeWorld` adds one built-in species, `grazer`, in a built-in skein, "Wildlife
  (built in)", with the kind `nature`. It releases one grazer named **Mossback** after the warm-up, on a walkable
  meadow or soil tile within 12 tiles of water, nearest the map centre. Old saves load with no animals.
- **Whims.** A plan can define `species` and `release` animals:

  ```json
  {"species": [ ...species... ],
   "release": [{"species": "lizard", "area": "spot", "count": 2, "names": ["Ember"]}]}
  ```

  - Released animals land on walkable tiles in the area. A plan can release at most 6 animals, and the world holds
    at most 24 living ones.
  - Erasing the skein removes its animals and the species it defined. If that species has animals released by
    other skeins, those animals and the species stay.
- **Tools (step 2b, optional).** A tool's edits can include `{"release": "grazer"}`, which drops one animal where you
  click. Its undo removes the animal.

## The model and honesty

**`describe()`** lists each species in one line and each animal with its needs, for example:

> Mossback (grazer) at (41,30): thirst 62%, hunger 85%, seeking water; drinks from water up to 0.3 m deep, eats
> meadow, avoids snow.

**`explainPlan`** describes a species from its data, so the description can't promise more than the species does:

> New animal: lizard (orange ring). It eats sand-moss, wades up to 0.1 m, climbs 2 m steps and walks 1.5 tiles a
> second. It can go 3 min without water and 5 min without food.

**Routing changes.** "Creatures that move" leaves the list of things Glomus can't do. These stay on it:
- flying, swimming underwater, talking or doing tricks;
- following the player or the mouse;
- herds, packs and breeding, until step 3. Herds and packs are listed as "herds and packs"; breeding is listed
  separately.
- one animal eating another, until step 3.

**Claims about animals.** Whether an animal will thrive isn't something the plan can promise: "the deer will love
the new pond" isn't checked, and "What it does" never says it. A claim like "it can't swim" is checked against
`wades`.

Threads don't read animals yet: there's no `{"near": "creature"}` condition. The player helps only through the land.
That's the point of the design.

## Scores and the page

**Scores.** `lifeStats(world)` returns, for each animal (alive or recently dead): its age, its seconds thriving
(both needs above 0.5), the whims since it was born, and its cause of death. Whims count each accepted whim skein
and each tool use. The page shows both styles side by side:

> 🐾 Mossback · alive 6:40 · thriving 82% · 3 whims · light-touch score 98 s per whim

**The map.**
- Each animal is a glyph: its species' colour and pattern, about one tile across, with a dark outline so it reads
  on any ground.
- A dead animal is a faded × for 30 s.

**Hovering an animal** shows its name, species, two need bars, its state ("seeking water"), and how long it's
lived.

**The legend**, a collapsible panel, has swatches for every material and glyphs for every species, each with how
many tiles or animals there are.

**Rewind and saves** carry the animals, species, `crng` and the whim count, like everything else.

## Tests first (TDD)

`game/tools/creatures_test.js` specifies steps 1 and 2. Run it with `npm run test:creatures`. Today every test fails,
because the API doesn't exist yet. The aim is to make them pass one by one, then move the file into `npm test`.

| area | what the tests pin down |
|---|---|
| The first animal | A new world has one living grazer, Mossback, on a walkable tile near water. Same seed, same animal; it never touches the weather stream. |
| Needs | Needs drain at the species' rates. With no water anywhere, it dies of thirst at the expected time. It then leaves a marker for 30 s. |
| Seeking | A thirsty animal walks to a pond it can see and drinks back to full. A hungry one eats meadow, which turns to soil. With nothing in sight, it searches. |
| Safety | It never steps into water deeper than `wades`, onto avoided ground, or up a step taller than `climbs`. It flees a flood and drowns if trapped. |
| Saves | Save/load and rewind keep its state, and it continues identically afterwards. |
| Species | `checkPlan` validates species and releases (bad pattern, unknown food, limits, name clashes). Release lands animals on walkable tiles. Erase removes a skein's animals and species. |
| Model | `describe()` lists animals and needs. `explainPlan` describes a species. Routing no longer refuses animals but still refuses herds, flying and following the mouse. |
| Scores | `lifeStats` counts thriving time and whims since birth, and tool uses count as whims. |

The eval cases come with the build, not now:
- **`thirsty-animal`**: "Mossback looks thirsty, help it." The animal should be drinking within 60 s, and the plan
  shouldn't flood its tile.
- **`invent-species`**: "A little orange lizard that loves warm sand and hates water." A species validates, the
  release lands, and the lizard survives 2 minutes.

## Steps 3–4, sketched

- **Groups.** A species gets `"group": "solitary" | "herd" | "pack"`:
  - A herd follows its leader and keeps close when nothing is urgent.
  - A pack hunts a target species together.
  - `"breeds": {"every": 120, "when": "fed"}` adds a young animal near a fed adult, up to a population cap.
  - Eating another species uses `eats: ["species:grazer"]`.
- **Camera and land.**
  - First, zoom and pan over a larger fixed map, say 256×160, to test the feel.
  - Then chunked, procedurally generated land, created as you pan or zoom out. Only chunks near the action are
    simulated, and water and animals cross chunk edges.
  - The model's world report covers the view, not the whole world.

## Questions for review

1. Is the name **Mossback** for the first animal OK? Alternatively, let the player name it.
2. Should a dead first animal stay dead (a light-touch run ends), or should a new grazer wander in after a while?
   I'd keep it dead, with a "Release another" button, so a death means something.
3. Should a tool that drops animals (step 2b) be in this round, or wait for step 3 with breeding?
