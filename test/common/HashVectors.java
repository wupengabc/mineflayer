import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import net.minecraft.util.HashOps;
import java.util.Map;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

// Run with the decompiled vanilla HashOps and its Guava/DFU dependencies.
// The holder codec encodes registered keys through Identifier.CODEC (a string).
class HashVectors {
  static final HashOps OPS = HashOps.CRC32C_INSTANCE;
  static <T> void show(String name, Codec<T> codec, T value) {
    System.out.println(name + "=" + codec.encodeStart(OPS, value).getOrThrow().asInt());
  }
  record Swing(String type, int duration) {}
  record Weapon(int damage, float disable) {}
  record Model(List<Float> floats, List<Boolean> flags, List<String> strings, List<Integer> colors) {}
  record Range(float min, float max, float creativeMin, float creativeMax, float margin, float mob) {}
  record Page(String raw, Optional<String> filtered) {}
  record WrittenBook(Page title, String author, int generation, List<Page> pages, boolean resolved) {}
  record Compostable(com.mojang.datafixers.util.Either<Integer, String> layers) {}
  record Cooking(com.mojang.datafixers.util.Either<Integer, String> burnTime, com.mojang.datafixers.util.Either<Float, String> speedMultiplier) {}
  record Explosion(String shape, List<Integer> colors, List<Integer> fadeColors, boolean trail, boolean twinkle) {}
  record Fireworks(int flight, List<Explosion> explosions) {}

  public static void main(String[] args) {
    show("color", Codec.INT, 0xabcdef);
    show("dye", Codec.STRING, "blue");
    show("enchantments", Codec.unboundedMap(Codec.STRING, Codec.INT), Map.of("minecraft:sharpness", 5, "custom:blessing", 2));
    show("villagerFood", RecordCodecBuilder.<Integer>create(i -> i.group(Codec.INT.fieldOf("nutrition").forGetter(x -> x)).apply(i, x -> x)), 8);
    var swing = RecordCodecBuilder.<Swing>create(i -> i.group(
      Codec.STRING.optionalFieldOf("type", "whack").forGetter(Swing::type),
      Codec.INT.optionalFieldOf("duration", 6).forGetter(Swing::duration)).apply(i, Swing::new));
    show("swingDefault", swing, new Swing("whack", 6));
    show("swingCustom", swing, new Swing("stab", 8));
    var weapon = RecordCodecBuilder.<Weapon>create(i -> i.group(
      Codec.INT.optionalFieldOf("item_damage_per_attack", 1).forGetter(Weapon::damage),
      Codec.FLOAT.optionalFieldOf("disable_blocking_for_seconds", 0f).forGetter(Weapon::disable)).apply(i, Weapon::new));
    show("weaponNegativeZero", weapon, new Weapon(1, -0f));
    var simple = OPS.createMap(Map.of(OPS.createString("id"), OPS.createString("minecraft:stone")));
    var patch = OPS.createMap(Map.of(
      OPS.createString("minecraft:damage"), OPS.createInt(37),
      OPS.createString("!minecraft:unbreakable"), OPS.emptyMap()));
    var patched = OPS.createMap(Map.of(
      OPS.createString("id"), OPS.createString("minecraft:stone"),
      OPS.createString("count"), OPS.createInt(2),
      OPS.createString("components"), patch));
    System.out.println("templateSimple=" + simple.asInt());
    System.out.println("emptyList=" + OPS.emptyList().asInt());
    System.out.println("templatePatched=" + patched.asInt());
    System.out.println("templateList=" + OPS.createList(Stream.of(simple, patched)).asInt());
    System.out.println("container=" + OPS.createList(Stream.of(
      OPS.createMap(Map.of(OPS.createString("slot"), OPS.createInt(1), OPS.createString("item"), patched)),
      OPS.createMap(Map.of(OPS.createString("slot"), OPS.createInt(3), OPS.createString("item"), simple)))).asInt());
    System.out.println("transientTemplate=" + OPS.createMap(Map.of(
      OPS.createString("id"), OPS.createString("minecraft:stone"), OPS.createString("components"), OPS.emptyMap())).asInt());
    var model = RecordCodecBuilder.<Model>create(i -> i.group(
      Codec.FLOAT.listOf().optionalFieldOf("floats", List.of()).forGetter(Model::floats),
      Codec.BOOL.listOf().optionalFieldOf("flags", List.of()).forGetter(Model::flags),
      Codec.STRING.listOf().optionalFieldOf("strings", List.of()).forGetter(Model::strings),
      Codec.INT.listOf().optionalFieldOf("colors", List.of()).forGetter(Model::colors)).apply(i, Model::new));
    show("modelEmpty", model, new Model(List.of(), List.of(), List.of(), List.of()));
    show("modelFull", model, new Model(List.of(0.5f, -0f), List.of(false, true), List.of("custom", "Hi"), List.of(0xabcdef)));
    var range = RecordCodecBuilder.<Range>create(i -> i.group(
      Codec.FLOAT.optionalFieldOf("min_reach", 0f).forGetter(Range::min),
      Codec.FLOAT.optionalFieldOf("max_reach", 3f).forGetter(Range::max),
      Codec.FLOAT.optionalFieldOf("min_creative_reach", 0f).forGetter(Range::creativeMin),
      Codec.FLOAT.optionalFieldOf("max_creative_reach", 5f).forGetter(Range::creativeMax),
      Codec.FLOAT.optionalFieldOf("hitbox_margin", 0.3f).forGetter(Range::margin),
      Codec.FLOAT.optionalFieldOf("mob_factor", 1f).forGetter(Range::mob)).apply(i, Range::new));
    show("rangeDefault", range, new Range(0f, 3f, 0f, 5f, 0.3f, 1f));
    show("rangeCustom", range, new Range(-0f, 4f, 1f, 6f, 0.5f, 1.5f));
    var page = RecordCodecBuilder.<Page>create(i -> i.group(
      Codec.STRING.fieldOf("raw").forGetter(Page::raw),
      Codec.STRING.optionalFieldOf("filtered").forGetter(Page::filtered)).apply(i, Page::new));
    var book = RecordCodecBuilder.<List<Page>>create(i -> i.group(
      page.listOf().optionalFieldOf("pages", List.of()).forGetter(x -> x)).apply(i, x -> x));
    show("writableEmpty", book, List.of());
    show("writablePages", book, List.of(new Page("hello", Optional.empty()), new Page("raw", Optional.of(""))));
    var writtenBook = RecordCodecBuilder.<WrittenBook>create(i -> i.group(
      page.fieldOf("title").forGetter(WrittenBook::title),
      Codec.STRING.fieldOf("author").forGetter(WrittenBook::author),
      Codec.INT.optionalFieldOf("generation", 0).forGetter(WrittenBook::generation),
      page.listOf().optionalFieldOf("pages", List.of()).forGetter(WrittenBook::pages),
      Codec.BOOL.optionalFieldOf("resolved", false).forGetter(WrittenBook::resolved)).apply(i, WrittenBook::new));
    show("writtenDefault", writtenBook, new WrittenBook(new Page("Title", Optional.empty()), "Author", 0, List.of(), false));
    show("writtenFilteredTitle", writtenBook, new WrittenBook(new Page("Title", Optional.of("")), "Author", 0, List.of(), false));
    var resolvableInt = Codec.either(Codec.INT, Codec.STRING);
    var resolvableFloat = Codec.either(Codec.FLOAT, Codec.STRING);
    var compostable = RecordCodecBuilder.<Compostable>create(i -> i.group(
      resolvableInt.fieldOf("layers").forGetter(Compostable::layers)).apply(i, Compostable::new));
    var cooking = RecordCodecBuilder.<Cooking>create(i -> i.group(
      resolvableInt.fieldOf("burn_time").forGetter(Cooking::burnTime),
      resolvableFloat.fieldOf("speed_multiplier").forGetter(Cooking::speedMultiplier)).apply(i, Cooking::new));
    show("compostConstant", compostable, new Compostable(com.mojang.datafixers.util.Either.left(300)));
    show("compostReference", compostable, new Compostable(com.mojang.datafixers.util.Either.right("minecraft:x")));
    show("cookingConstant", cooking, new Cooking(com.mojang.datafixers.util.Either.left(1600), com.mojang.datafixers.util.Either.left(1.5f)));
    show("cookingReference", cooking, new Cooking(com.mojang.datafixers.util.Either.right("minecraft:x"), com.mojang.datafixers.util.Either.right("minecraft:y")));
    var brewing = RecordCodecBuilder.<Cooking>create(i -> i.group(
      resolvableInt.fieldOf("uses").forGetter(Cooking::burnTime),
      resolvableFloat.fieldOf("speed_multiplier").forGetter(Cooking::speedMultiplier)).apply(i, Cooking::new));
    show("brewingConstant", brewing, new Cooking(com.mojang.datafixers.util.Either.left(20), com.mojang.datafixers.util.Either.left(0.5f)));
    show("brewingReference", brewing, new Cooking(com.mojang.datafixers.util.Either.right("minecraft:x"), com.mojang.datafixers.util.Either.right("minecraft:y")));
    show("potteryPattern", Codec.STRING, "minecraft:flow");
    var explosion = RecordCodecBuilder.<Explosion>create(i -> i.group(
      Codec.STRING.fieldOf("shape").forGetter(Explosion::shape),
      Codec.INT.listOf().optionalFieldOf("colors", List.of()).forGetter(Explosion::colors),
      Codec.INT.listOf().optionalFieldOf("fade_colors", List.of()).forGetter(Explosion::fadeColors),
      Codec.BOOL.optionalFieldOf("has_trail", false).forGetter(Explosion::trail),
      Codec.BOOL.optionalFieldOf("has_twinkle", false).forGetter(Explosion::twinkle)).apply(i, Explosion::new));
    var fireworks = RecordCodecBuilder.<Fireworks>create(i -> i.group(
      Codec.BYTE.xmap(Byte::toUnsignedInt, Integer::byteValue).optionalFieldOf("flight_duration", 0).forGetter(Fireworks::flight),
      explosion.sizeLimitedListOf(256).optionalFieldOf("explosions", List.of()).forGetter(Fireworks::explosions)).apply(i, Fireworks::new));
    var explosionDefault = new Explosion("small_ball", List.of(), List.of(), false, false);
    var explosionCustom = new Explosion("star", List.of(0xabcdef, -1), List.of(0x123456), true, true);
    show("explosionDefault", explosion, explosionDefault);
    show("explosionCustom", explosion, explosionCustom);
    show("fireworksEmpty", fireworks, new Fireworks(0, List.of()));
    show("fireworksFlight1", fireworks, new Fireworks(1, List.of()));
    show("fireworksFlight255", fireworks, new Fireworks(255, List.of()));
    show("fireworksCustom", fireworks, new Fireworks(255, List.of(explosionDefault, explosionCustom)));
    var styledText = OPS.createMap(Map.of(
      OPS.createString("text"), OPS.createString("hello"),
      OPS.createString("bold"), OPS.createBoolean(false),
      OPS.createString("color"), OPS.createString("#00ABCD"),
      OPS.createString("font"), OPS.createString("minecraft:uniform")));
    System.out.println("styledText=" + styledText.asInt());
    System.out.println("siblings=" + OPS.createMap(Map.of(
      OPS.createString("text"), OPS.createString("root"),
      OPS.createString("extra"), OPS.createList(Stream.of(OPS.createString("child"), styledText)))).asInt());
    System.out.println("translation=" + OPS.createMap(Map.of(
      OPS.createString("translate"), OPS.createString("custom.message"),
      OPS.createString("fallback"), OPS.createString("fallback"),
      OPS.createString("with"), OPS.createList(Stream.of(OPS.createInt(7), OPS.createInt(2))))).asInt());
    System.out.println("keybind=" + OPS.createMap(Map.of(
      OPS.createString("keybind"), OPS.createString("key.jump"),
      OPS.createString("italic"), OPS.createBoolean(true))).asInt());
    System.out.println("textFalse=" + OPS.createMap(Map.of(
      OPS.createString("text"), OPS.createString("hello"), OPS.createString("italic"), OPS.createBoolean(false))).asInt());
    System.out.println("textLore=" + OPS.createList(Stream.of(OPS.createString("hello"), styledText)).asInt());
    var title = OPS.createMap(Map.of(OPS.createString("raw"), OPS.createString("Title")));
    var bookPage = OPS.createMap(Map.of(OPS.createString("raw"), styledText, OPS.createString("filtered"), OPS.createString("filtered")));
    System.out.println("writtenBook=" + OPS.createMap(Map.of(
      OPS.createString("title"), title, OPS.createString("author"), OPS.createString("Author"),
      OPS.createString("generation"), OPS.createInt(2), OPS.createString("resolved"), OPS.createBoolean(true),
      OPS.createString("pages"), OPS.createList(Stream.of(bookPage)))).asInt());
  }
}
